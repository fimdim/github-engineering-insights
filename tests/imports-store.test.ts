import { afterEach, describe, expect, it } from 'vitest';
import { previewImport, csvEscape, templates } from '../apps/server/imports.js';
import { Store } from '../packages/data/store.js';
import { calculate } from '../packages/metrics/engine.js';
import { dataset, fact, filters, scope } from './fixtures.js';

const survey = (rows = 'team-a,2026-10-01,2026-10-02,satisfaction,1,5,10,4.2,15') => templates.surveys + rows + '\n';
describe('CSV imports', () => {
  it('accepts valid aggregate surveys and preserves a stable correction identity', () => {
    const first = previewImport('surveys', survey(), scope, dataset([]));
    expect(first.errors).toEqual([]);
    expect(first.count).toBe(1);
    const corrected = previewImport('surveys', survey().replace('4.2', '4.5'), scope, dataset(first.facts));
    expect(corrected.errors).toEqual([]);
    expect(corrected.facts[0]?.id).toBe(first.facts[0]?.id);
  });
  it('rejects identities/free-text fields, invalid scales and out-of-range scores', () => {
    expect(previewImport('surveys', survey().replace('team,from', 'user,team,from').replace('team-a,', 'private-user,team-a,'), scope, dataset([])).errors.length).toBeGreaterThan(0);
    expect(previewImport('surveys', survey().replace(',10,4.2,', ',10,6.2,'), scope, dataset([])).errors[0]?.message).toContain('scale');
  });
  it('rejects impossible dates, duplicate headers, and duplicate identities', () => {
    expect(previewImport('surveys', survey().replace('2026-10-01', '2026-02-30'), scope, dataset([])).errors.length).toBeGreaterThan(0);
    expect(() => previewImport('surveys', 'team,team\nx,x\n', scope, dataset([]))).toThrow('unique headers');
    const row = 'team-a,2026-10-01,2026-10-02,satisfaction,1,5,10,4.2,15';
    expect(previewImport('surveys', survey(`${row}\n${row}`), scope, dataset([])).errors[0]?.message).toContain('Duplicate');
  });
  it('rejects overlapping survey periods', () => {
    const first = previewImport('surveys', survey(), scope, dataset([]));
    expect(previewImport('surveys', survey().replace('2026-10-02', '2026-10-03'), scope, dataset(first.facts)).errors[0]?.message).toContain('overlaps');
  });
  it('suppresses survey cohorts below five at calculation, not just in the UI', () => {
    const preview = previewImport('surveys', survey().replace(',10,4.2,15', ',4,4.2,15'), scope, dataset([]));
    expect(preview.suppressedRows).toBe(1);
    const metric = calculate(dataset(preview.facts), scope, { ...filters, service: '', team: 'team-a' }).metrics.find(m => m.id === 'space.satisfaction');
    expect(metric).toMatchObject({ value: null, sample: null, status: 'suppressed', series: [] });
  });
  it('does not silently blend incompatible survey scales', () => {
    const rows = [
      fact('surveys', 's1', { team: 'team-a', question: 'satisfaction', from: filters.from, to: filters.from, min: 1, max: 5, score: 4, responses: 10 }),
      fact('surveys', 's2', { team: 'team-a', question: 'satisfaction', from: filters.to, to: filters.to, min: 1, max: 10, score: 8, responses: 10 }, filters.to),
    ];
    expect(calculate(dataset(rows), scope, { ...filters, service: '', team: 'team-a' }).metrics.find(m => m.id === 'space.satisfaction')?.value).toBeNull();
  });
  it('accepts explicit zero-incident observation coverage', () => {
    const csv = templates.incidents + 'coverage,api,,,,,,2026-10-01,2026-10-02\n';
    const preview = previewImport('incidents', csv, scope, dataset([]));
    expect(preview.errors).toEqual([]);
    expect(preview.facts[0]?.source).toBe('observation');
  });
  it('requires exact production deployment evidence for incident links', () => {
    const csv = templates.incidents + 'incident,api,incident-1,2026-10-01T12:00:00Z,2026-10-01T14:00:00Z,api:test-org/api:1,,,\n';
    expect(previewImport('incidents', csv, scope, dataset([])).errors[0]?.message).toContain('Deployment link');
    const deployment = fact('deployments', 'api:test-org/api:1', { service: 'api' });
    expect(previewImport('incidents', csv, scope, dataset([deployment])).errors).toEqual([]);
    expect(previewImport('incidents', csv.replace('14:00', '11:00'), scope, dataset([deployment])).errors.length).toBeGreaterThan(0);
  });
  it('escapes spreadsheet formula injection in exports', () => {
    for (const value of ['=SUM(A1)', '+cmd', '-cmd', '@cmd', ' \t=cmd']) expect(csvEscape(value)).toMatch(/^"'/);
    expect(csvEscape('a"b')).toBe('"a""b"');
  });
});

describe('SQLite persistence', () => {
  let store: Store;
  afterEach(() => store?.close());
  it('migrates and stores idempotent facts and settings', () => {
    store = new Store(':memory:');
    store.saveSettings({ scopes: [scope] });
    expect(store.settings().scopes[0]).toEqual(scope);
    store.putMany('test', [fact('commits', 'c', {}), fact('commits', 'c', { corrected: true })]);
    expect(store.dataset('test').facts).toHaveLength(1);
    expect(store.dataset('test').facts[0]?.data.corrected).toBe(true);
  });
  it('rolls back all rows on import transaction failure', () => {
    store = new Store(':memory:');
    expect(() => store.transaction(() => { store.put('test', fact('surveys', 's', {})); throw new Error('Rejected'); })).toThrow('Rejected');
    expect(store.dataset('test').facts).toEqual([]);
  });
  it('replaces report days and checkpoints atomically to prevent overlap duplication', () => {
    store = new Store(':memory:');
    store.replaceDay('test', 'copilot', filters.from, [fact('copilot', 'd', { count: 1 })]);
    store.replaceDay('test', 'copilot', filters.from, [fact('copilot', 'd', { count: 2 })]);
    expect(store.dataset('test').facts).toHaveLength(1);
    expect(store.dataset('test').facts[0]?.data.count).toBe(2);
    expect(store.hasCheckpoint('test', 'copilot', filters.from)).toBe(true);
  });
  it('keeps scope stores isolated and prunes detailed Copilot data', () => {
    store = new Store(':memory:');
    store.put('test', fact('users', 'old', {}, '2026-08-01'));
    store.put('other', fact('users', 'other', {}, '2026-08-01'));
    store.prune('test', Date.parse('2026-10-19'));
    expect(store.dataset('test').facts).toEqual([]);
    expect(store.dataset('other').facts).toHaveLength(1);
  });
});
