import type { Dataset, Fact, Filters, Scope } from '../packages/metrics/types.js';

export const scope: Scope = {
  id: 'test', kind: 'organization', slug: 'test-org', repositories: ['test-org/api'],
  services: [{ id: 'api', name: 'API', repository: 'test-org/api', environment: 'production' }],
};
export const filters: Filters = { scope: 'test', service: 'api', team: '', from: '2026-10-01', to: '2026-10-02' };
export const fact = (source: string, id: string, data: Record<string, unknown>, day = '2026-10-01'): Fact => ({ source, id, data, day });
export const dataset = (facts: Fact[], sources = ['deployments:test-org/api', 'pulls:test-org/api', 'runs:test-org/api', 'issues:test-org/api', 'commits:test-org/api', 'copilot', 'users', 'surveys', 'incidents']): Dataset => ({
  facts,
  statuses: sources.map(source => ({ source, state: 'ready', message: 'Fixture evidence', updatedAt: '2026-10-03T00:00:00Z', from: '2026-09-01', to: '2026-10-02' })),
});
