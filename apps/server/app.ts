import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../packages/data/store.js';
import { calculate, safeTeams } from '../../packages/metrics/engine.js';
import { catalog } from '../../packages/metrics/catalog.js';
import { demoDataset, demoScope } from '../../packages/metrics/demo.js';
import { dateKey, DAY, daysBetween } from '../../packages/metrics/types.js';
import type { Filters, Scope } from '../../packages/metrics/types.js';
import { ConnectorError, githubRequest, SyncCoordinator } from './github.js';
import { csvEscape, daySchema, previewImport, templates } from './imports.js';
import {
  CopilotCliError, createCopilotSummaryPayload, generateCopilotSummary,
  type CopilotSummaryPayload,
} from './copilot-summary.js';

const slug = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/);
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).refine(value => value !== 'demo', 'demo is reserved.');
const repository = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).max(200);
const settingsSchema = z.object({
  scopes: z.array(z.object({
    id, kind: z.literal('enterprise'), slug,
    allowSmallEnterpriseAggregates: z.boolean().optional(),
    repositories: z.array(repository).max(20),
    services: z.array(z.object({ id, name: z.string().min(1).max(100), repository, environment: z.string().min(1).max(100) }).strict()).max(20),
  }).strict()).max(1, 'Only one enterprise can be connected at a time. Remove it before connecting another.'),
}).strict().superRefine((settings, ctx) => {
  if (new Set(settings.scopes.map(s => s.id)).size !== settings.scopes.length) ctx.addIssue({ code: 'custom', message: 'Scope IDs must be unique.' });
  for (const scope of settings.scopes) {
    if (new Set(scope.repositories).size !== scope.repositories.length || new Set(scope.services.map(s => s.id)).size !== scope.services.length) ctx.addIssue({ code: 'custom', message: 'Repository names and service IDs must be unique within each scope.' });
    if (scope.services.some(s => !scope.repositories.includes(s.repository))) ctx.addIssue({ code: 'custom', message: 'Each service must reference a configured repository.' });
  }
});
export interface AppOptions {
  port: number;
  store: Store;
  coordinator?: SyncCoordinator;
  copilotSummary?: (payload: CopilotSummaryPayload) => Promise<string>;
}
export function createApp({ port, store, coordinator = new SyncCoordinator(store), copilotSummary = generateCopilotSummary }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  const csrf = randomBytes(32).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (!hosts.has(req.headers.host ?? '')) { res.status(403).json({ error: 'Unrecognized host. Open the loopback URL printed by the server.' }); return; }
    if (req.path.startsWith('/api/')) {
      if ((req.headers.origin && !origins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ error: 'Cross-origin API requests are not allowed.' }); return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const token = req.headers['x-local-csrf'];
        if (typeof token !== 'string' || token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) {
          res.status(403).json({ error: 'Local session expired. Reload the app before changing data.' }); return;
        }
      }
    }
    next();
  });
  // Compressed bodies are rejected to avoid the body-parser 2.x inflate DoS (GHSA-27r3-jxmh-p828).
  app.use(express.json({ limit: '3mb', inflate: false }));
  const selectedScope = (value: unknown): Scope => {
    if (value === 'demo' || !value) return demoScope;
    const scopes = store.settings().scopes;
    if (scopes.length > 1) throw new Error('Choose one enterprise in Connections & data before using live data.');
    const scope = scopes.find(s => s.id === value);
    if (!scope) throw new Error('Unknown scope. Configure a connection first.');
    return scope;
  };
  const read = (query: Record<string, unknown>) => {
    const scope = selectedScope(query.scope);
    const from = daySchema.parse(query.from ?? dateKey(Date.now() - 28 * DAY));
    const to = daySchema.parse(query.to ?? dateKey(Date.now() - DAY));
    if (from > to || daysBetween(from, to) >= 90 || to > dateKey(Date.now())) throw new Error('Select a valid date window of at most 90 days, ending no later than today.');
    const service = typeof query.service === 'string' ? query.service : '';
    const team = typeof query.team === 'string' ? query.team : '';
    if (service && !scope.services.some(s => s.id === service)) throw new Error('Unknown service.');
    if (service && team) throw new Error('Service and Copilot/survey team filters cannot be combined.');
    const dataset = scope.id === 'demo' ? demoDataset() : store.dataset(scope.id);
    const allowedTeams = [...safeTeams(dataset.facts.filter(f => f.day >= from && f.day <= to)), ...dataset.facts.filter(f => f.source === 'surveys' && Number(f.data.responses) >= 5).map(f => ({ id: String(f.data.team), name: String(f.data.team) }))];
    if (team && !allowedTeams.some(t => t.id === team)) throw new Error('Team is unavailable or withheld by privacy rules.');
    const filters: Filters = { scope: scope.id, from, to, service, team };
    const dashboard = calculate(dataset, scope, filters, scope.id === 'demo');
    dashboard.teams = [...new Map(allowedTeams.map(t => [t.id, t])).values()];
    return { dashboard, dataset, scope };
  };
  app.get('/api/session', (_req, res) => res.json({ csrf, version: '0.1.0', canvas: { available: false, reason: 'Project canvas registration requires SDK extension scaffold/reload tooling, which was not available in the authoring session. The shared web app is ready.' } }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/catalog', (_req, res) => res.json(catalog));
  app.get('/api/settings', (_req, res) => res.json(store.settings()));
  app.put('/api/settings', (req, res) => {
    if (coordinator.progress.running) { res.status(409).json({ error: 'Cancel the active sync before changing connections.' }); return; }
    const settings = settingsSchema.parse(req.body);
    for (const previous of store.settings().scopes) {
      const next = settings.scopes.find(s => s.id === previous.id);
      if (!next) throw new Error('Use Remove enterprise before connecting a different enterprise or clearing this connection.');
      if (next && (next.slug !== previous.slug || next.kind !== previous.kind)) throw new Error('Scope identity is immutable. Use a new scope ID for a different organization or enterprise.');
      for (const service of previous.services) {
        const updated = next?.services.find(s => s.id === service.id);
        if (updated && (updated.repository !== service.repository || updated.environment !== service.environment)) throw new Error('Production mapping identity is immutable. Use a new service ID to avoid mixing historical evidence.');
      }
    }
    store.saveSettings(settings);
    res.json(settings);
  });
  app.delete('/api/enterprise', (req, res) => {
    const { scope: scopeId } = z.object({ scope: id }).strict().parse(req.body);
    if (coordinator.progress.running) { res.status(409).json({ error: 'Finish or cancel the active sync before removing the enterprise.' }); return; }
    if (!store.settings().scopes.some(s => s.id === scopeId)) { res.status(404).json({ error: 'This enterprise is no longer connected. Reload the page.' }); return; }
    store.removeScope(scopeId);
    if (coordinator.progress.scope === scopeId) coordinator.progress = { running: false, scope: null, task: 'Enterprise removed', completed: 0, failures: 0, startedAt: null };
    res.json(store.settings());
  });
  app.post('/api/enterprise/select', (req, res) => {
    const { scope: scopeId } = z.object({ scope: id }).strict().parse(req.body);
    if (coordinator.progress.running) { res.status(409).json({ error: 'Finish or cancel the active sync before changing enterprises.' }); return; }
    const scopes = store.settings().scopes;
    if (!scopes.some(s => s.id === scopeId && s.kind === 'enterprise')) { res.status(404).json({ error: 'This enterprise is no longer connected. Reload the page.' }); return; }
    store.removeScopes(scopes.filter(s => s.id !== scopeId).map(s => s.id));
    if (coordinator.progress.scope !== scopeId) coordinator.progress = { running: false, scope: null, task: 'Enterprise selection saved', completed: 0, failures: 0, startedAt: null };
    res.json(store.settings());
  });
  app.get('/api/dashboard', (req, res) => res.json(read(req.query).dashboard));
  app.post('/api/analysis/copilot', async (req, res) => {
    const input = z.object({
      scope: z.string().min(1).max(100),
      from: daySchema,
      to: daySchema,
      service: z.string().max(100),
      team: z.string().max(100),
      domains: z.array(z.enum(['DORA', 'SPACE', 'Copilot'])).min(1).max(3),
    }).strict().superRefine((value, ctx) => {
      if (new Set(value.domains).size !== value.domains.length) ctx.addIssue({ code: 'custom', message: 'Summary domains must be unique.' });
    }).parse(req.body);
    const { dashboard } = read(input);
    const payload = createCopilotSummaryPayload(dashboard, input.domains);
    try {
      const summary = await copilotSummary(payload);
      res.json({ summary });
    } catch (error) {
      if (error instanceof CopilotCliError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(502).json({ error: 'Copilot CLI could not generate a summary. Check its installation and sign-in, then retry.' });
    }
  });
  app.get('/api/export', (req, res) => {
    const { dashboard } = read(req.query);
    const rows = dashboard.metrics.map(result => ({ ...catalog.find(def => def.id === result.id)!, ...result, series: undefined }));
    if (req.query.format === 'csv') {
      const keys = ['id', 'name', 'framework', 'dimension', 'unit', 'value', 'status', 'reason', 'numerator', 'denominator', 'formula', 'source'] as const;
      res.type('text/csv').attachment('delivery-metrics.csv').send([keys.join(','), ...rows.map(row => keys.map(key => csvEscape(row[key])).join(','))].join('\r\n'));
    } else res.attachment('delivery-metrics.json').json({ mode: dashboard.mode, filters: dashboard.filters, notices: dashboard.notices, metrics: rows });
  });
  app.get('/api/deployments', (req, res) => {
    const { dataset } = read(req.query);
    const rows = dataset.facts.filter(f => f.source === 'deployments').map(f => ({ id: f.id, service: f.data.service, delivered_at: f.data.delivered_at }));
    res.json(rows);
  });
  app.get('/api/templates/:kind', (req, res) => {
    const kind = z.enum(['incidents', 'surveys']).parse(req.params.kind);
    res.type('text/csv').attachment(`${kind}-template.csv`).send(templates[kind]);
  });
  app.post('/api/import', (req, res) => {
    const input = z.object({ scope: z.string(), kind: z.enum(['surveys', 'incidents']), csv: z.string(), commit: z.boolean().default(false), fingerprint: z.string().optional() }).strict().parse(req.body);
    const scope = selectedScope(input.scope);
    if (scope.id === 'demo') { res.status(400).json({ error: 'Demo data is read-only. Configure a live connection before importing.' }); return; }
    if (coordinator.progress.running) { res.status(409).json({ error: 'Finish or cancel sync before importing incident evidence.' }); return; }
    const preview = previewImport(input.kind, input.csv, scope, store.dataset(scope.id));
    if (input.commit) {
      if (input.fingerprint !== preview.fingerprint) throw new Error('Preview has changed. Preview this exact file before importing.');
      if (preview.errors.length) throw new Error('Import has row errors. No rows were saved.');
      store.transaction(() => {
        for (const fact of preview.facts) store.put(scope.id, fact);
        store.status(scope.id, { source: input.kind, state: 'ready', message: `${preview.count} validated aggregate/evidence rows imported.`, updatedAt: new Date().toISOString() });
      });
    }
    // No underlying survey/incident row contents are sent back to the browser.
    res.json({ ...preview, facts: undefined, committed: input.commit });
  });
  app.get('/api/sync', (_req, res) => res.json(coordinator.progress));
  app.post('/api/sync', (req, res) => {
    const scope = selectedScope(z.object({ scope: z.string() }).strict().parse(req.body).scope);
    if (scope.id === 'demo') { res.status(400).json({ error: 'Demo data is read-only; add a live connection first.' }); return; }
    if (coordinator.progress.running) { res.status(409).json({ error: 'A sync is already running.' }); return; }
    coordinator.start(scope);
    res.status(202).json(coordinator.progress);
  });
  app.post('/api/sync/cancel', (_req, res) => { coordinator.cancel(); res.json({ cancelled: true }); });
  app.get('/api/connection', async (_req, res) => {
    try {
      await githubRequest('user');
      res.json({ state: 'ready', message: 'GitHub CLI is authenticated to github.com. Source-specific access is checked during sync.' });
    } catch (error) {
      res.json({ state: error instanceof ConnectorError ? error.state : 'error', message: error instanceof ConnectorError ? error.message : 'Could not check GitHub authentication.' });
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  const errorHandler: express.ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') :
      error instanceof Error && !('code' in error) ? error.message : 'Local storage/request failed. Check server diagnostics before retrying.';
    if (!(error instanceof z.ZodError) && error instanceof Error && 'code' in error) console.error('Local operation failed:', String(error.code));
    res.status(400).json({ error: message });
  };
  app.use(errorHandler);
  return { app, coordinator };
}
