import { describe, expect, it } from 'vitest';
import { ConnectorError, SyncCoordinator } from '../apps/server/github.js';
import { Store } from '../packages/data/store.js';
import { dateKey, DAY } from '../packages/metrics/types.js';
import { scope } from './fixtures.js';

describe('Source-isolated sync coordinator', () => {
  it('retains successful repository metadata when all Copilot sources deny access', async () => {
    const store = new Store(':memory:');
    const now = Date.parse(dateKey(Date.now()));
    const at = (ago: number) => new Date(now - ago * DAY + 12 * 3_600_000).toISOString();
    const request = async (path: string): Promise<unknown> => {
      if (path.includes('/copilot/')) throw new ConnectorError('forbidden', 'Fixture permission denial');
      if (path.includes('/compare/')) return { status: 'ahead', total_commits: 1, commits: [{ sha: 'b', commit: { committer: { date: at(3) } } }] };
      if (path.includes('/deployments/2/statuses')) return [{ state: 'success', created_at: at(2) }, { state: 'success', created_at: at(2) }];
      if (path.includes('/deployments/1/statuses')) return [{ state: 'success', created_at: at(3) }];
      if (path.includes('/deployments?')) return [{ id: 2, sha: 'b', environment: 'production', created_at: at(2) }, { id: 1, sha: 'a', environment: 'production', created_at: at(3) }];
      if (path.includes('/actions/runs')) return { workflow_runs: [] };
      return [];
    };
    const coordinator = new SyncCoordinator(store, request);
    coordinator.start(scope);
    await coordinator.settled();
    const data = store.dataset(scope.id);
    expect(coordinator.progress.running).toBe(false);
    expect(data.facts.filter(f => f.source === 'deployments')).toHaveLength(2);
    expect(data.facts.filter(f => f.source === 'changes')).toHaveLength(1);
    expect(data.statuses.find(s => s.source === 'deployments:test-org/api')?.state).toBe('ready');
    expect(data.statuses.find(s => s.source === 'copilot')?.state).toBe('forbidden');
    coordinator.start(scope);
    await coordinator.settled();
    expect(store.dataset(scope.id).facts.filter(f => f.source === 'deployments')).toHaveLength(2);
    store.close();
  });
  it('allows cancellation without inventing a successful source state', async () => {
    const store = new Store(':memory:');
    const coordinator = new SyncCoordinator(store, async (_path, signal) => {
      return await new Promise((_resolve, reject) => {
        if (signal?.aborted) reject(new Error('Cancelled'));
        signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      });
    });
    coordinator.start(scope);
    expect(() => coordinator.start(scope)).toThrow('already running');
    coordinator.cancel();
    await coordinator.settled();
    expect(coordinator.progress.running).toBe(false);
    expect(store.dataset(scope.id).statuses[0]?.state).toBe('cancelled');
    store.close();
  });
  it('checks newer dates after absent reports, retains usable data, and retries missing days on resume', async () => {
    const store = new Store(':memory:');
    const enterprise = { ...scope, kind: 'enterprise' as const, repositories: [], services: [] };
    const oldest = dateKey(Date.now() - 28 * DAY);
    const requests: string[] = [];
    const downloads: string[] = [];
    const coordinator = new SyncCoordinator(store, async path => {
      requests.push(path);
      if (path.includes('enterprise-1-day')) {
        const day = new URL(`https://api.github.com/${path}`).searchParams.get('day')!;
        return day === oldest ? null : { download_links: [`https://copilot-reports.github.com/${day}`] };
      }
      if (path.includes('user-teams-1-day')) return '';
      return null;
    }, async function* (link) {
      downloads.push(link);
      yield { day: new URL(link).pathname.slice(1), daily_active_users: 10 };
    });
    try {
      coordinator.start(enterprise);
      await coordinator.settled();
      const first = store.dataset(scope.id);
      expect(requests.filter(p => p.includes('enterprise-1-day'))).toHaveLength(28);
      expect(requests.filter(p => p.includes('user-teams-1-day'))).toHaveLength(28);
      expect(requests.filter(p => p.includes('repos-1-day'))).toHaveLength(28);
      expect(first.facts.filter(f => f.source === 'copilot')).toHaveLength(27);
      expect(first.statuses.find(s => s.source === 'copilot')?.state).toBe('partial');
      expect(first.statuses.find(s => s.source === 'copilot')).not.toHaveProperty('from');
      expect(first.statuses.find(s => s.source === 'copilot')).not.toHaveProperty('to');
      expect(first.statuses.find(s => s.source === 'teams')?.state).toBe('unsupported');
      expect(first.statuses.find(s => s.source === 'repoCopilot')?.message).toContain('All dates were checked');
      expect(store.hasCheckpoint(scope.id, 'copilot', oldest)).toBe(false);
      expect(store.hasCheckpoint(scope.id, 'teams', oldest)).toBe(false);
      expect(downloads).toHaveLength(27);
      requests.length = 0;
      coordinator.start(enterprise);
      await coordinator.settled();
      expect(requests.some(p => p.includes(`enterprise-1-day?day=${oldest}`))).toBe(true);
      expect(store.dataset(scope.id).facts.filter(f => f.source === 'copilot')).toHaveLength(27);
      expect(store.dataset(scope.id).statuses.find(s => s.source === 'copilot')?.state).toBe('partial');
    } finally { store.close(); }
  });
});
