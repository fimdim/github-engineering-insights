import { describe, expect, it } from 'vitest';
import { createCopilotSummaryPayload } from '../apps/server/copilot-summary.js';
import { calculate } from '../packages/metrics/engine.js';
import { dataset, filters, scope } from './fixtures.js';

describe('Copilot summary payload', () => {
  it('excludes identifiers, detailed records, and withheld metric values', () => {
    const dashboard = calculate(dataset([]), scope, filters);
    const selected = {
      ...dashboard,
      metrics: dashboard.metrics.map(result => result.id === 'copilot.dau'
        ? { ...result, status: 'suppressed' as const, value: 17, previous: 12, sample: 3 }
        : result),
      sources: [{
        source: 'copilot:private-team',
        state: 'ready' as const,
        message: 'private-user-detail',
        updatedAt: '2026-10-01T00:00:00Z',
      }],
    };
    const payload = createCopilotSummaryPayload(selected, ['Copilot']);
    const activeUsers = payload.metrics.find(metric => metric.id === 'copilot.dau');
    expect(activeUsers).toMatchObject({ status: 'suppressed', current: null, previous: null });
    expect(payload.filters).toEqual({ serviceSelected: true, teamSelected: false });
    expect(payload.sources).toEqual([{ family: 'copilot', state: 'ready' }]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(scope.slug);
    expect(serialized).not.toContain(scope.services[0]!.name);
    expect(serialized).not.toContain(scope.repositories[0]!);
    expect(serialized).not.toContain('private-team');
    expect(serialized).not.toContain('private-user-detail');
    expect(serialized).not.toContain('"sample"');
    expect(serialized).not.toContain('"series"');
  });
});
