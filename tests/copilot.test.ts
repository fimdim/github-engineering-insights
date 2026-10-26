import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregateUsers, calculate, safeTeams } from '../packages/metrics/engine.js';
import { downloadReport, normalizeReport, pages, reportLinks, validateReportUrl } from '../apps/server/github.js';
import { dataset, fact, filters, scope } from './fixtures.js';
const all = { ...filters, service: '' };
const metric = (id: string, facts: ReturnType<typeof fact>[], f = all) => calculate(dataset(facts), scope, f).metrics.find(m => m.id === id)!;
const daily = (day: string, data: Record<string, unknown>) => fact('copilot', day, { daily_active_users: 10, ...data }, day);
describe('Copilot report normalization', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('strips logins, prompts, text, URLs and records only numeric/dimensional telemetry', () => {
    const [row] = normalizeReport('users', { day: filters.from, user_id: 1, user_login: 'private-name', prompt: 'secret prompt', download_url: 'https://secret', user_initiated_interaction_count: 4, used_cli: true, totals_by_feature: [{ feature: 'agent', user_initiated_interaction_count: 2, title: 'private' }] }, filters.from, scope);
    expect(row?.data).toEqual({ user_id: 1, user_initiated_interaction_count: 4, used_cli: true, totals_by_feature: [{ feature: 'agent', user_initiated_interaction_count: 2 }] });
  });
  it('normalizes day_totals without mixing report windows', () => {
    expect(normalizeReport('copilot', { day_totals: [{ day: filters.from, daily_active_users: 9 }] }, filters.from, scope)).toHaveLength(1);
    expect(() => normalizeReport('copilot', { day: filters.to, daily_active_users: 9 }, filters.from, scope)).toThrow('does not match');
  });
  it('uses the documented repo_id and configured repository mapping', () => {
    const row = { day: filters.from, repo_id: 42, repo_owner_name: 'test-org', repo_name: 'api', pull_requests: { total_created: 2 } };
    expect(normalizeReport('repoCopilot', row, filters.from, scope)[0]?.data.repository).toBe('test-org/api');
    expect(normalizeReport('repoCopilot', { ...row, repo_name: 'unselected' }, filters.from, scope)).toEqual([]);
  });
  it('rejects an incompatible daily aggregate schema', () => {
    expect(() => normalizeReport('copilot', { day: filters.from }, filters.from, scope)).toThrow('daily_active_users');
  });
  it('validates signed report delivery destinations', () => {
    expect(validateReportUrl('https://copilot-reports.github.com/reports/file?sig=synthetic').hostname).toBe('copilot-reports.github.com');
    expect(() => validateReportUrl('https://copilot-reports.github.com.evil.test/report')).toThrow();
    expect(validateReportUrl('https://reports123.blob.core.windows.net/reports/file?sig=not-a-real-secret').hostname).toBe('reports123.blob.core.windows.net');
    for (const url of ['http://127.0.0.1/a', 'https://localhost/a', 'https://example.com/a', 'https://api.github.com.evil.test/a', 'https://user:pass@api.github.com/a', 'https://api.github.com:8080/a']) expect(() => validateReportUrl(url)).toThrow();
  });
  it('distinguishes unavailable reports from malformed report metadata', () => {
    for (const response of [null, '', { download_links: [] }]) expect(reportLinks(response)).toBeNull();
    expect(reportLinks({ download_links: ['https://copilot-reports.github.com/example'] })).toEqual(['https://copilot-reports.github.com/example']);
    for (const response of [undefined, {}, 'unexpected', { download_links: 'not-an-array' }, { download_links: [null] }, { download_links: Array(17).fill('https://copilot-reports.github.com/example') }]) {
      expect(() => reportLinks(response)).toThrow();
    }
  });
  it('downloads NDJSON from the GitHub report host without credentials and validates redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"day":"2026-10-01","daily_active_users":10}\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const rows = [];
    for await (const row of downloadReport('https://copilot-reports.github.com/report?sig=synthetic', new AbortController().signal)) rows.push(row);
    expect(rows).toEqual([{ day: '2026-10-01', daily_active_users: 10 }]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers');
    fetchMock.mockReset().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(async () => {
      for await (const _row of downloadReport('https://copilot-reports.github.com/report', new AbortController().signal)) { /* Consume the stream. */ }
    }).rejects.toThrow('allowlist');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('paginates lists and fails incompatible shapes explicitly', async () => {
    let count = 0;
    const rows = await pages(async () => ++count === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 101 }], 'repos/test-org/api/pulls');
    expect(rows).toHaveLength(101);
    await expect(pages(async () => ({ unexpected: [] }), 'repos/test-org/api/pulls')).rejects.toThrow('schema');
  });
});
describe('Copilot calculation and privacy', () => {
  it('uses latest unique-user counters, never adds DAU into WAU/MAU', () => {
    const rows = [daily(filters.from, { weekly_active_users: 16 }), daily(filters.to, { daily_active_users: 12, weekly_active_users: 18 })];
    expect(metric('copilot.dau', rows).value).toBe(12);
    expect(metric('copilot.wau', rows).value).toBe(18);
  });
  it('uses only completion counters for acceptance', () => {
    const rows = [daily(filters.from, { totals_by_feature: [{ feature: 'code_completion', code_generation_activity_count: 100, code_acceptance_activity_count: 25 }, { feature: 'chat', code_generation_activity_count: 10000, code_acceptance_activity_count: 9000 }] })];
    expect(metric('copilot.completion-acceptance', rows).value).toBe(25);
  });
  it('does not coerce missing report fields into zero', () => {
    expect(metric('copilot.cli-sessions', [daily(filters.from, {})]).value).toBeNull();
    expect(metric('copilot.completion-acceptance', [daily(filters.from, { totals_by_feature: [{ feature: 'code_completion' }] })]).value).toBeNull();
  });
  it('withholds small daily cohorts and their usage counters', () => {
    const rows = [daily(filters.from, { daily_active_users: 3, user_initiated_interaction_count: 500 })];
    expect(metric('copilot.dau', rows).status).toBe('suppressed');
    expect(metric('copilot.interactions', rows).value).toBeNull();
  });
  it('keeps successfully synced small cohorts suppressed across values, trends, previous windows and breakdowns', () => {
    const rows = [daily(filters.from, { daily_active_users: 2, user_initiated_interaction_count: 500, totals_by_feature: [{ feature: 'agent', user_initiated_interaction_count: 500 }] }), daily(filters.to, { daily_active_users: 2, user_initiated_interaction_count: 600 })];
    const dashboard = calculate(dataset(rows), scope, all);
    expect(dashboard.sources.find(s => s.source === 'copilot')?.state).toBe('ready');
    for (const id of ['copilot.dau', 'copilot.interactions', 'copilot.completion-acceptance']) {
      expect(dashboard.metrics.find(m => m.id === id)).toMatchObject({ value: null, previous: null, sample: null, status: 'suppressed', series: [] });
    }
    expect(dashboard.breakdowns).toEqual([]);
  });
  it('requires explicit enterprise-only consent for small aggregate values and breakdowns', () => {
    const rows = [daily(filters.from, { daily_active_users: 2, user_initiated_interaction_count: 8, totals_by_feature: [{ feature: 'agent', user_initiated_interaction_count: 8 }] })];
    const enterprise = { ...scope, kind: 'enterprise' as const };
    expect(calculate(dataset(rows), enterprise, all).metrics.find(m => m.id === 'copilot.dau')?.status).toBe('suppressed');
    const enabled = calculate(dataset(rows), { ...enterprise, allowSmallEnterpriseAggregates: true }, all);
    expect(enabled.metrics.find(m => m.id === 'copilot.dau')?.value).toBe(2);
    expect(enabled.metrics.find(m => m.id === 'copilot.interactions')?.value).toBe(8);
    expect(enabled.breakdowns.length).toBeGreaterThan(0);
    expect(enabled.notices.join(' ')).toContain('individual activity');
    expect(JSON.stringify(enabled)).not.toContain('user_id');
    expect(calculate(dataset(rows), { ...scope, allowSmallEnterpriseAggregates: true }, all).metrics.find(m => m.id === 'copilot.dau')?.status).toBe('suppressed');
    const service = calculate(dataset(rows), { ...enterprise, allowSmallEnterpriseAggregates: true }, filters);
    expect(service.metrics.find(m => m.id === 'copilot.dau')?.value).toBeNull();
    expect(service.breakdowns).toEqual([]);
    const team = calculate(dataset(rows), { ...enterprise, allowSmallEnterpriseAggregates: true }, { ...all, team: 'small' });
    expect(team.metrics.find(m => m.id === 'copilot.dau')?.value).toBeNull();
    expect(team.breakdowns).toEqual([]);
  });
  it('does not manufacture missing counters with opt-in and preserves reported zero', () => {
    const enterprise = { ...scope, kind: 'enterprise' as const, allowSmallEnterpriseAggregates: true };
    const missing = calculate(dataset([fact('copilot', 'missing', { user_initiated_interaction_count: 8 })]), enterprise, all);
    expect(missing.metrics.find(m => m.id === 'copilot.dau')?.value).toBeNull();
    expect(missing.breakdowns).toEqual([]);
    const zero = calculate(dataset([daily(filters.from, { daily_active_users: 0, user_initiated_interaction_count: 0 })]), enterprise, all);
    expect(zero.metrics.find(m => m.id === 'copilot.dau')?.value).toBe(0);
    expect(zero.metrics.find(m => m.id === 'copilot.interactions')?.value).toBe(0);
    expect(zero.metrics.find(m => m.id === 'copilot.completion-acceptance')?.value).toBeNull();
  });
  it('marks a partial additive window rather than implying full coverage', () => {
    expect(metric('copilot.interactions', [daily(filters.from, { user_initiated_interaction_count: 4 })])).toMatchObject({ value: 4, status: 'partial' });
  });
  it('shows only latest reported daily median, not a median of medians', () => {
    const rows = [daily(filters.from, { pull_requests: { median_minutes_to_merge_copilot_authored: 10 } }), daily(filters.to, { pull_requests: { median_minutes_to_merge_copilot_authored: 90 } })];
    expect(metric('copilot.cloud-merge-time', rows).value).toBe(90);
  });
  it('weights tokens by actual requests, not daily averages', () => {
    const rows = [daily(filters.from, { totals_by_cli: { request_count: 1, token_usage: { prompt_tokens_sum: 100, output_tokens_sum: 100 } } }), daily(filters.to, { totals_by_cli: { request_count: 9, token_usage: { prompt_tokens_sum: 900, output_tokens_sum: 900 } } })];
    expect(metric('copilot.cli-tokens-average', rows).value).toBe(200);
  });
  it('disables IDE service attribution but supports repository-level PR evidence', () => {
    const rows = [daily(filters.from, { user_initiated_interaction_count: 100 }), fact('repoCopilot', 'repo', { repository: 'test-org/api', pull_requests: { total_created_by_copilot: 3 } })];
    expect(metric('copilot.interactions', rows, filters).value).toBeNull();
    expect(metric('copilot.pr-cloud', rows, filters).value).toBe(3);
  });
  it('joins daily team activity without importing activity from other days', () => {
    const users = Array.from({ length: 10 }, (_, user_id) => fact('users', `u${user_id}`, { user_id, used_agent: true, user_initiated_interaction_count: 2 }));
    const teams = users.map((u, index) => fact('teams', `t${index}`, { user_id: u.data.user_id, team_id: index < 5 ? 1 : 2 }));
    const laterUser = fact('users', 'later', { user_id: 1, used_agent: true, user_initiated_interaction_count: 100 }, filters.to);
    const rows = [...users, ...teams, laterUser];
    expect(metric('copilot.interactions', rows, { ...all, team: '1' }).value).toBe(10);
  });
  it('withholds small complements and overlapping-group differences', () => {
    const users = Array.from({ length: 10 }, (_, user_id) => fact('users', `u${user_id}`, { user_id }));
    const teams = Array.from({ length: 7 }, (_, user_id) => fact('teams', `t${user_id}`, { user_id, team_id: 1 }));
    expect(safeTeams([...users, ...teams])).toEqual([]);
  });
  it('deduplicates user IDs and excludes identity numbers from metric totals', () => {
    const users = Array.from({ length: 5 }, (_, user_id) => fact('users', `u${user_id}`, { user_id, used_agent: true, loc_added_sum: 2 }));
    const [aggregate] = aggregateUsers([...users, users[0]!]);
    expect(aggregate?.data.daily_active_users).toBe(5);
    expect(aggregate?.data.loc_added_sum).toBe(10);
    expect(aggregate?.data).not.toHaveProperty('user_id');
  });
  it('requires exact report windows for feature engagement', () => {
    const window = fact('copilotWindow', 'w', { from: filters.from, to: filters.to, engagement: { totals_by_feature: [{ feature: 'agent_edit', engaged_user_count: 10 }] } });
    expect(metric('copilot.engagement-agent_edit', [window]).value).toBe(10);
    expect(metric('copilot.engagement-agent_edit', [window], { ...all, from: '2026-09-30' }).value).toBeNull();
  });
});
