import { describe, expect, it } from 'vitest';
import { analyzeDomain, analyzeOverall } from '../packages/metrics/analysis.js';
import { calculate } from '../packages/metrics/engine.js';
import type { Dashboard, MetricResult } from '../packages/metrics/types.js';
import { dataset, filters, scope } from './fixtures.js';

function dashboardWith(changes: Record<string, Partial<MetricResult>> = {}, selectedFilters = filters): Dashboard {
  const base = calculate(dataset([]), scope, selectedFilters);
  return {
    ...base,
    metrics: base.metrics.map(result => ({
      ...result, value: null, previous: null, status: 'unavailable', ...changes[result.id],
    })),
  };
}

describe('evidence-based analysis summaries', () => {
  it('highlights favorable and unfavorable changes using catalog direction', () => {
    const dashboard = dashboardWith({
      'dora.lead': { value: 8, previous: 10, status: 'measured' },
      'dora.failure': { value: 6, previous: 4, status: 'measured' },
    });
    const summary = analyzeDomain(dashboard, 'DORA');
    expect(summary.tone).toBe('watch');
    expect(summary.findings).toHaveLength(3);
    expect(summary.findings[0]).toContain('Change lead time fell 20.0%');
    expect(summary.findings[0]).toContain('favorable');
    expect(summary.findings[1]).toContain('Change fail rate rose 50.0%');
    expect(summary.findings[1]).toContain('unfavorable');
    expect(summary.findings[2]).toContain('Key evidence gap');
  });

  it('reports contextual usage movements without describing them as good or bad', () => {
    const summary = analyzeDomain(dashboardWith({
      'copilot.dau': { value: 12, previous: 10, status: 'measured' },
    }), 'Copilot');
    expect(summary.tone).toBe('neutral');
    expect(summary.findings[0]).toContain('Daily active users rose 20.0%');
    expect(summary.findings[0]).toContain('contextual, not an outcome rating');
  });

  it('keeps the Copilot narrative focused on adoption and engagement rather than consumption', () => {
    const summary = analyzeDomain(dashboardWith({
      'copilot.dau': { value: 12, previous: 10, status: 'measured' },
      'copilot.credits': { value: 2000, previous: 1000, status: 'measured' },
    }), 'Copilot');
    expect(summary.findings[0]).toContain('Daily active users');
    expect(summary.findings.join(' ')).not.toContain('AI credits');
  });

  it('formats singular duration units correctly in narrative comparisons', () => {
    const summary = analyzeDomain(dashboardWith({
      'space.pr-age': { value: 2.5, previous: 0.96, status: 'measured' },
    }), 'SPACE');
    expect(summary.findings.join(' ')).toContain('1 day to 2.5 days');
    expect(summary.findings.join(' ')).not.toContain('1 days');
  });

  it('reports coverage and never uses suppressed values as findings', () => {
    const summary = analyzeDomain(dashboardWith({
      'space.satisfaction': { value: null, previous: null, status: 'suppressed' },
      'space.pr-cycle': { value: 8, previous: null, status: 'partial' },
    }), 'SPACE');
    expect(summary.coverage.withheld).toBe(1);
    expect(summary.coverage.partial).toBe(1);
    expect(summary.coverage.unavailable).toBe(summary.coverage.total - 2);
    expect(summary.findings.join(' ')).not.toContain('satisfaction');
    expect(summary.findings[0]).toContain('Current readings are available');
  });

  it('asks for a service before assessing DORA and makes no portfolio score', () => {
    const unfiltered = { ...filters, service: '' };
    const summary = analyzeDomain(dashboardWith({
      'dora.lead': { value: 4, previous: 8, status: 'measured' },
    }, unfiltered), 'DORA');
    expect(summary.tone).toBe('limited');
    expect(summary.findings.join(' ')).toContain('Select one service');
    expect(analyzeOverall(dashboardWith({}, unfiltered)).domains.map(item => item.domain)).toEqual(['DORA', 'SPACE', 'Copilot']);
  });

  it('qualifies partial measures and names unsupported source coverage', () => {
    const base = dashboardWith({
      'copilot.interactions': { value: 20, previous: null, status: 'partial' },
    });
    const dashboard = {
      ...base,
      sources: [{ source: 'teams', state: 'unsupported' as const, message: 'Unavailable', updatedAt: '2026-10-01' }],
    };
    const summary = analyzeDomain(dashboard, 'Copilot');
    expect(summary.coverage.partial).toBe(1);
    expect(summary.sourceGaps).toEqual([{ source: 'teams', state: 'unsupported' }]);
    expect(summary.findings.join(' ')).toContain('not enough comparable history');
  });
});
