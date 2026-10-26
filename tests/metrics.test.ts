import { describe, expect, it } from 'vitest';
import { catalog, dimensions } from '../packages/metrics/catalog.js';
import { calculate, quantile } from '../packages/metrics/engine.js';
import { dataset, fact, filters, scope } from './fixtures.js';

const result = (id: string, facts: ReturnType<typeof fact>[], overrides = {}) => calculate(dataset(facts), scope, { ...filters, ...overrides }).metrics.find(m => m.id === id)!;
const deployment = (id: string, at = '2026-10-01T12:00:00Z') => fact('deployments', id, { service: 'api', repository: 'test-org/api', delivered_at: at });
const observation = fact('observation', 'window', { service: 'api', from: filters.from, to: filters.to });
describe('Catalog', () => {
  it('has five primary DORA metrics, five SPACE dimensions and no duplicate IDs', () => {
    expect(catalog.filter(m => m.framework === 'DORA')).toHaveLength(5);
    expect(dimensions.SPACE).toHaveLength(5);
    expect(new Set(catalog.filter(m => m.framework === 'SPACE').map(m => m.dimension)).size).toBe(5);
    expect(new Set(catalog.map(m => m.id)).size).toBe(catalog.length);
    expect(catalog.length).toBeGreaterThan(80);
    expect(catalog.every(m => m.formula && m.source && m.caveat)).toBe(true);
  });
});
describe('DORA', () => {
  it('counts distinct production deployments per calendar day including measured zero days', () => {
    const d = deployment('a');
    const value = result('dora.frequency', [d, d, deployment('b')]);
    expect(value.value).toBe(1);
    expect(value.sample).toBe(2);
    expect(value.series).toEqual([{ day: '2026-10-01', value: 2 }, { day: '2026-10-02', value: 0 }]);
  });
  it('requires a single configured service', () => {
    expect(result('dora.frequency', [deployment('a')], { service: '' }).value).toBeNull();
  });
  it('does not substitute CI runs or PR merges for production deployments', () => {
    expect(result('dora.frequency', [fact('runs', 'run', { conclusion: 'success' })]).value).toBe(0);
    const unconnected = calculate({ facts: [], statuses: [] }, scope, filters);
    expect(unconnected.metrics.find(m => m.id === 'dora.frequency')?.status).toBe('unavailable');
  });
  it('computes median/p90 lead time from proven change-deployment linkage', () => {
    const changes = [2, 4, 30].map((hours, i) => fact('changes', `c${i}`, { service: 'api', deployment: 'd1', committed_at: new Date(Date.parse('2026-10-02T12:00:00Z') - hours * 3_600_000).toISOString(), deployed_at: '2026-10-02T12:00:00Z' }));
    const value = result('dora.lead', [deployment('d1', '2026-10-02T12:00:00Z'), ...changes]);
    expect(value.value).toBe(4);
    expect(value.p90).toBeCloseTo(24.8);
    expect(value.series[0]?.value).toBe(4);
  });
  it('rejects negative lead times instead of turning them into zero', () => {
    expect(result('dora.lead', [deployment('d'), fact('changes', 'c', { service: 'api', deployment: 'd', committed_at: '2026-10-02T12:00:00Z', deployed_at: '2026-10-01T12:00:00Z' })]).value).toBeNull();
  });
  it('does not infer zero failures without observation coverage', () => {
    expect(result('dora.failure', [deployment('d')]).value).toBeNull();
    expect(result('dora.rework', [deployment('d')]).value).toBeNull();
  });
  it('deduplicates failed/rework deployment IDs across multiple incidents', () => {
    const incidents = ['i1', 'i2'].map(id => fact('incidents', id, { service: 'api', failed_at: '2026-10-01T13:00:00Z', recovered_at: '2026-10-01T15:00:00Z', failed_deployments: ['d1'], rework_deployments: ['d2'] }));
    const evidence = [deployment('d1'), deployment('d2'), observation, ...incidents];
    expect(result('dora.failure', evidence)).toMatchObject({ value: 50, numerator: 1, denominator: 2 });
    expect(result('dora.rework', evidence).value).toBe(50);
  });
  it('handles zero denominators as unavailable, not zero percent', () => {
    expect(result('dora.failure', [observation]).value).toBeNull();
  });
  it('includes recovery for failures in-window from an earlier deployment', () => {
    const recovery = result('dora.recovery', [deployment('old', '2026-09-30T12:00:00Z'), fact('incidents', 'i', { service: 'api', failed_at: '2026-10-01T01:00:00Z', recovered_at: '2026-10-01T04:00:00Z', failed_deployments: ['old'] })]);
    expect(recovery.value).toBe(3);
  });
  it('flags unresolved incidents without inventing a recovery duration', () => {
    const value = result('dora.recovery', [deployment('d'), fact('incidents', 'i', { service: 'api', failed_at: '2026-10-01T13:00:00Z', recovered_at: null, failed_deployments: ['d'] })]);
    expect(value.value).toBeNull();
    expect(value.status).toBe('partial');
    expect(value.reason).toContain('unresolved');
  });
});
describe('SPACE and source coverage', () => {
  const pull = fact('pulls', 'p', { repository: 'test-org/api', author_id: 1, created_at: '2026-09-30T12:00:00Z', merged_at: '2026-10-01T12:00:00Z', closed_at: '2026-10-01T12:00:00Z' });
  it('keeps PR cycle time separate from DORA lead time', () => {
    expect(result('space.pr-cycle', [pull]).value).toBe(24);
    expect(result('dora.lead', [pull]).value).toBeNull();
  });
  it('excludes bots and author self-review from human response time', () => {
    const review = (id: string, user: number, at: string, bot = false) => fact('reviews', id, { repository: 'test-org/api', pull_id: 'p', author_id: 1, user_id: user, submitted_at: at, bot });
    const pr = { ...pull, data: { ...pull.data, created_at: '2026-10-01T00:00:00Z' } };
    const rows = [pr, review('r1', 2, '2026-10-01T00:15:00Z', true), review('r2', 1, '2026-10-01T00:30:00Z'), review('r3', 3, '2026-10-01T03:00:00Z')];
    expect(result('space.review-response', rows).value).toBe(3);
  });
  it('uses an end-of-window WIP snapshot, not current state alone', () => {
    const pr = { ...pull, data: { ...pull.data, closed_at: '2026-10-03T01:00:00Z' } };
    expect(result('space.wip', [pr]).value).toBe(1);
  });
  it('never calls updated_at a CI finish timestamp', () => {
    expect(result('space.ci-duration', [fact('runs', 'r', { updated_at: '2026-10-01T12:00:00Z' })]).value).toBeNull();
  });
  it('suppresses small reviewer cohorts', () => {
    expect(result('space.reviewers', [fact('reviews', 'r', { user_id: 1, author_id: 2, submitted_at: '2026-10-01T12:00:00Z' })]).status).toBe('suppressed');
  });
  it('marks a multi-repository total partial when one repository was never synced', () => {
    const value = calculate(dataset([pull]), { ...scope, repositories: [...scope.repositories, 'test-org/web'] }, { ...filters, service: '' }).metrics.find(m => m.id === 'space.pr-merged')!;
    expect(value.status).toBe('partial');
  });
  it('does not expose a previous-window number when prior coverage is missing', () => {
    const data = dataset([pull]); data.statuses.forEach(s => { s.from = '2026-10-01'; });
    expect(calculate(data, scope, filters).metrics.find(m => m.id === 'space.pr-merged')?.previous).toBeNull();
  });
  it('interpolates percentiles deterministically without mutating inputs', () => {
    const values = [9, 1, 3, 5];
    expect(quantile(values)).toBe(4);
    expect(values).toEqual([9, 1, 3, 5]);
    expect(quantile([])).toBeNull();
  });
});
