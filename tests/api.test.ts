import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Store } from '../packages/data/store.js';
import { createApp } from '../apps/server/app.js';
import { scope } from './fixtures.js';
import type { Dashboard } from '../packages/metrics/types.js';
import { SyncCoordinator } from '../apps/server/github.js';
import type { CopilotSummaryPayload } from '../apps/server/copilot-summary.js';

describe('Loopback HTTP API', () => {
  let server: Server, store: Store, base: string, token: string;
  let coordinator: SyncCoordinator;
  let summaryPayload: CopilotSummaryPayload | undefined;
  // Reserve an ephemeral listener, then configure exact Host validation from its real port.
  beforeAll(async () => {
    const { createServer } = await import('node:http');
    store = new Store(':memory:');
    store.saveSettings({ scopes: [scope] });
    const placeholder = createServer();
    await new Promise<void>(resolve => placeholder.listen(0, '127.0.0.1', resolve));
    const address = placeholder.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port.');
    const port = address.port;
    await new Promise<void>(resolve => placeholder.close(() => resolve()));
    coordinator = new SyncCoordinator(store);
    const { app } = createApp({
      port, store, coordinator,
      copilotSummary: async payload => { summaryPayload = payload; return 'Generated evidence summary.'; },
    });
    server = await new Promise<Server>(resolve => { const listener = app.listen(port, '127.0.0.1', () => resolve(listener)); });
    base = `http://127.0.0.1:${port}`;
    token = (await (await fetch(`${base}/api/session`)).json() as { csrf: string }).csrf;
  });
  afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); store?.close(); });
  const post = (path: string, data: unknown, csrf = token) => fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-CSRF': csrf }, body: JSON.stringify(data) });
  it('requires valid CSRF on mutations and blocks cross-origin reads', async () => {
    expect((await post('sync/cancel', {}, 'invalid')).status).toBe(403);
    expect((await fetch(`${base}/api/settings`, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    const { get } = await import('node:http');
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/api/settings`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    expect(hostStatus).toBe(403);
    expect((await post('sync/cancel', {})).status).toBe(200);
  });
  it('rejects compressed JSON request bodies', async () => {
    const { gzipSync } = await import('node:zlib');
    const response = await fetch(`${base}/api/sync/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-Local-CSRF': token }, body: gzipSync('{}') });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toMatch(/encoding/i);
  });
  it('provides a deterministic read-only demo with no person-level facts', async () => {
    const response = await fetch(`${base}/api/dashboard?scope=demo`);
    const value = await response.json() as Dashboard;
    expect(value.mode).toBe('demo');
    expect(value.metrics.length).toBeGreaterThan(80);
    expect(JSON.stringify(value)).not.toContain('user_id');
    expect(JSON.stringify(value)).not.toContain('user_login');
    expect((await post('sync', { scope: 'demo' })).status).toBe(400);
  });
  it('does not fabricate live values before sync', async () => {
    const dashboard = await (await fetch(`${base}/api/dashboard?scope=test`)).json() as Dashboard;
    expect(dashboard.mode).toBe('live');
    expect(dashboard.metrics.filter(m => m.value !== null)).toHaveLength(0);
  });
  it('generates an opt-in summary from filtered aggregate evidence only', async () => {
    const dashboard = await (await fetch(`${base}/api/dashboard?scope=demo`)).json() as Dashboard;
    const response = await post('analysis/copilot', { ...dashboard.filters, domains: ['Copilot'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'Generated evidence summary.' });
    expect(summaryPayload?.domains.map(domain => domain.domain)).toEqual(['Copilot']);
    expect(summaryPayload?.metrics.length).toBeGreaterThan(0);
    expect(summaryPayload?.metrics.every(metric => !('sample' in metric) && !('series' in metric))).toBe(true);
    expect(summaryPayload?.filters).toEqual({ serviceSelected: false, teamSelected: false });
    const serialized = JSON.stringify(summaryPayload);
    expect(serialized).not.toContain('"scope"');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('user_login');
    expect(serialized).not.toContain('demo-enterprise');
  });
  it('rejects invalid or duplicate Copilot summary domains', async () => {
    const dashboard = await (await fetch(`${base}/api/dashboard?scope=demo`)).json() as Dashboard;
    expect((await post('analysis/copilot', { ...dashboard.filters, domains: ['DORA', 'DORA'] })).status).toBe(400);
    expect((await post('analysis/copilot', { ...dashboard.filters, domains: ['unknown'] })).status).toBe(400);
  });
  it('validates unknown scopes, invalid dates, and incompatible filters', async () => {
    expect((await fetch(`${base}/api/dashboard?scope=missing`)).status).toBe(400);
    expect((await fetch(`${base}/api/dashboard?scope=demo&from=2026-02-30`)).status).toBe(400);
    expect((await fetch(`${base}/api/dashboard?scope=demo&service=checkout&team=checkout-team`)).status).toBe(400);
  });
  it('exports the privacy-filtered result shape and definitions only', async () => {
    const response = await fetch(`${base}/api/export?scope=demo&format=csv`);
    expect(response.headers.get('content-disposition')).toContain('delivery-metrics.csv');
    const csv = await response.text();
    expect(csv).toContain('numerator,denominator,formula,source');
    expect(csv).not.toContain('user_id');
    expect(csv).not.toContain('download_links');
  });
  it('prevents imports without a matching validated preview fingerprint', async () => {
    const csv = 'team,from,to,question,min,max,responses,score,eligible\nteam-a,2026-10-01,2026-10-02,satisfaction,1,5,10,4,15\n';
    const input = { scope: 'test', kind: 'surveys', csv, commit: true, fingerprint: 'not-previewed' };
    expect((await post('import', input)).status).toBe(400);
    expect(store.dataset('test').facts).toHaveLength(0);
    const preview = await (await post('import', { ...input, commit: false })).json() as { fingerprint: string };
    expect((await post('import', { ...input, fingerprint: preview.fingerprint })).status).toBe(200);
    expect(store.dataset('test').facts).toHaveLength(1);
  });
  it('rejects unknown settings fields and cross-organization repository scope', async () => {
    const response = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Local-CSRF': token }, body: JSON.stringify({ scopes: [{ ...scope, repositories: ['another-org/private'] }] }) });
    expect(response.status).toBe(400);
    expect(store.settings().scopes[0]?.repositories).toEqual(scope.repositories);
  });
  const put = (scopes: unknown[]) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Local-CSRF': token }, body: JSON.stringify({ scopes }) });
  const remove = (scopeId: string, csrf = token) => fetch(`${base}/api/enterprise`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Local-CSRF': csrf }, body: JSON.stringify({ scope: scopeId }) });
  it('supports only demo plus one enterprise, without silently replacing a connection', async () => {
    const enterprise = { ...scope, kind: 'enterprise' };
    store.saveSettings({ scopes: [] });
    expect((await put([scope])).status).toBe(400);
    expect((await put([enterprise, { ...enterprise, id: 'second' }])).status).toBe(400);
    expect((await put([enterprise])).status).toBe(200);
    expect(store.settings().scopes[0]?.allowSmallEnterpriseAggregates).not.toBe(true);
    expect((await put([{ ...enterprise, id: 'second', slug: 'second-enterprise' }])).status).toBe(400);
    expect((await put([])).status).toBe(400);
    expect((await put([{ ...enterprise, allowSmallEnterpriseAggregates: true }])).status).toBe(200);
    expect(store.settings().scopes[0]?.allowSmallEnterpriseAggregates).toBe(true);
    expect((await put([{ ...enterprise, allowSmallEnterpriseAggregates: false }])).status).toBe(200);
  });
  it('guards removal and clears all enterprise data before another connection is created', async () => {
    store.put('test', { source: 'copilot', id: 'day', day: '2026-10-01', data: { daily_active_users: 10 } });
    store.status('test', { source: 'copilot', state: 'ready', message: 'Retained', updatedAt: '2026-10-01' });
    store.checkpoint('test', 'copilot', '2026-10-01');
    store.put('unrelated', { source: 'copilot', id: 'other', day: '2026-10-01', data: { daily_active_users: 10 } });
    expect((await remove('test', 'wrong')).status).toBe(403);
    coordinator.progress.running = true;
    expect((await remove('test')).status).toBe(409);
    expect(store.dataset('test').facts.length).toBeGreaterThan(0);
    coordinator.progress.running = false;
    coordinator.progress.scope = 'test';
    expect((await remove('missing')).status).toBe(404);
    expect((await remove('test')).status).toBe(200);
    expect(store.settings()).toEqual({ scopes: [] });
    expect(store.dataset('test')).toEqual({ facts: [], statuses: [] });
    expect(store.hasCheckpoint('test', 'copilot', '2026-10-01')).toBe(false);
    expect(store.dataset('unrelated').facts).toHaveLength(1);
    expect(coordinator.progress.scope).toBeNull();
    expect((await fetch(`${base}/api/dashboard?scope=test`)).status).toBe(400);
    expect((await fetch(`${base}/api/export?scope=test`)).status).toBe(400);
    expect((await fetch(`${base}/api/dashboard?scope=demo`)).status).toBe(200);
    expect((await put([{ ...scope, kind: 'enterprise' }])).status).toBe(200);
    expect(store.dataset('test')).toEqual({ facts: [], statuses: [] });
    expect(store.settings().scopes[0]?.allowSmallEnterpriseAggregates).not.toBe(true);
  });
  it('requires an explicit choice for legacy multiple connections and preserves only the chosen evidence', async () => {
    const enterprise = { ...scope, kind: 'enterprise' as const };
    store.saveSettings({ scopes: [enterprise, { ...enterprise, id: 'second', slug: 'second' }] });
    for (const scopeId of ['test', 'second']) {
      store.put(scopeId, { source: 'copilot', id: 'day', day: '2026-10-01', data: { daily_active_users: 10 } });
      store.status(scopeId, { source: 'copilot', state: 'ready', message: 'Retained', updatedAt: '2026-10-01' });
      store.checkpoint(scopeId, 'copilot', '2026-10-01');
    }
    expect((await fetch(`${base}/api/dashboard?scope=test`)).status).toBe(400);
    expect((await fetch(`${base}/api/dashboard?scope=demo`)).status).toBe(200);
    expect((await post('enterprise/select', { scope: 'test' }, 'invalid')).status).toBe(403);
    coordinator.progress.running = true;
    expect((await post('enterprise/select', { scope: 'test' })).status).toBe(409);
    coordinator.progress.running = false;
    expect((await post('enterprise/select', { scope: 'missing' })).status).toBe(404);
    expect(store.settings().scopes).toHaveLength(2);
    expect((await post('enterprise/select', { scope: 'test' })).status).toBe(200);
    expect(store.settings().scopes).toEqual([enterprise]);
    expect(store.dataset('test').facts).toHaveLength(1);
    expect(store.hasCheckpoint('test', 'copilot', '2026-10-01')).toBe(true);
    expect(store.dataset('second')).toEqual({ facts: [], statuses: [] });
    expect(store.hasCheckpoint('second', 'copilot', '2026-10-01')).toBe(false);
    expect((await fetch(`${base}/api/dashboard?scope=test`)).status).toBe(200);
  });
});
