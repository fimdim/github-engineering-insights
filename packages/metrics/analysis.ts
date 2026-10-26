import { catalog } from './catalog.js';
import type { Dashboard, Framework, MetricDefinition, MetricResult } from './types.js';

export type AnalysisDomain = Framework | 'Overall';
export type AnalysisTone = 'positive' | 'watch' | 'neutral' | 'limited';

export interface DomainAnalysis {
  domain: Framework;
  tone: AnalysisTone;
  findings: string[];
  coverage: { available: number; partial: number; withheld: number; unavailable: number; total: number };
  sourceGaps: { source: string; state: string }[];
}

export interface OverallAnalysis {
  domains: DomainAnalysis[];
  available: number;
  total: number;
}

const valueText = (value: number, definition: MetricDefinition) => {
  const maximumFractionDigits = ['count', 'tokens'].includes(definition.unit) ? 0 : 1;
  const valueString = new Intl.NumberFormat('en', { maximumFractionDigits }).format(value);
  if (definition.unit === 'count') {
    if (definition.name.toLowerCase().includes('user')) return `${valueString} users`;
    if (definition.name.toLowerCase().includes('pull request')) return `${valueString} pull requests`;
    if (definition.name.toLowerCase().includes('incident')) return `${valueString} incidents`;
    return valueString;
  }
  if (definition.unit === 'days') return `${valueString} ${Math.abs(Number(valueString.replaceAll(',', ''))) === 1 ? 'day' : 'days'}`;
  const suffix: Partial<Record<MetricDefinition['unit'], string>> = {
    percent: '%', hours: ' h', minutes: ' min', 'per day': '/day',
  };
  return `${valueString}${suffix[definition.unit] ?? ` ${definition.unit}`}`;
};

function movement(result: MetricResult, definition: MetricDefinition) {
  const current = result.value!;
  const previous = result.previous!;
  const delta = current - previous;
  const favorable = definition.direction === 'context' ? null : definition.direction === 'higher' ? delta > 0 : delta < 0;
  const comparison = previous === 0
    ? `${valueText(current, definition)} from ${valueText(0, definition)}`
    : `${Math.abs(delta / Math.abs(previous) * 100).toFixed(1)}% (${valueText(previous, definition)} to ${valueText(current, definition)})`;
  const verb = previous === 0 ? (current > 0 ? 'rose' : 'fell') : (delta > 0 ? 'rose' : 'fell');
  const interpretation = favorable === null
    ? 'this measure is contextual, not an outcome rating'
    : `its defined direction is ${favorable ? 'favorable' : 'unfavorable'}`;
  return {
    favorable,
    magnitude: Math.abs(delta) / Math.max(Math.abs(previous), Math.abs(current), 1),
    statement: `${definition.name} ${verb} ${comparison}; ${interpretation}.`,
  };
}

function definitionsFor(domain: Framework) {
  return catalog.filter(definition => definition.framework === domain);
}

const sourceFamilies: Record<Framework, string[]> = {
  DORA: ['deployments', 'pulls', 'runs', 'issues', 'commits', 'incidents'],
  SPACE: ['pulls', 'reviews', 'issues', 'runs', 'commits', 'surveys', 'incidents'],
  Copilot: ['copilot', 'copilotWindow', 'repoCopilot', 'seats', 'teams', 'users'],
};

const headlineMetrics: Record<Framework, string[]> = {
  DORA: ['dora.frequency', 'dora.lead', 'dora.recovery', 'dora.failure', 'dora.rework'],
  SPACE: [
    'space.satisfaction', 'space.friction', 'space.sustainability', 'space.copilot-usefulness',
    'space.ci-failure', 'space.quality', 'space.incidents', 'space.pr-merged',
    'space.review-response', 'space.review-coverage', 'space.cross-team',
    'space.pr-cycle', 'space.pr-ready', 'space.pr-age', 'space.wip',
    'space.issue-resolution', 'space.ci-queue', 'space.ci-duration', 'space.ci-retry',
  ],
  Copilot: [
    'copilot.seats', 'copilot.seat-active', 'copilot.inactive-seats',
    'copilot.dau', 'copilot.wau', 'copilot.mau', 'copilot.agent-users', 'copilot.chat-users',
    'copilot.completion-acceptance', 'copilot.repeat', 'copilot.interactions', 'copilot.agent-adoption',
  ],
};

export function analyzeDomain(dashboard: Dashboard, domain: Framework): DomainAnalysis {
  const definitions = definitionsFor(domain);
  const byId = new Map(dashboard.metrics.map(result => [result.id, result]));
  const entries = definitions.flatMap(definition => {
    const result = byId.get(definition.id);
    return result ? [{ definition, result }] : [];
  });
  const coverage = {
    available: entries.filter(({ result }) => result.status === 'measured').length,
    partial: entries.filter(({ result }) => result.status === 'partial').length,
    withheld: entries.filter(({ result }) => result.status === 'suppressed').length,
    unavailable: 0,
    total: definitions.length,
  };
  coverage.unavailable = coverage.total - coverage.available - coverage.partial - coverage.withheld;
  const sourceGaps = dashboard.sources
    .filter(source => sourceFamilies[domain].includes(source.source.split(':')[0] ?? '') && !['ready', 'empty'].includes(source.state))
    .map(source => ({ source: source.source, state: source.state }));
  if (domain === 'DORA' && !dashboard.filters.service) {
    return {
      domain, tone: 'limited',
      findings: ['Select one service to assess delivery outcomes; DORA metrics are not blended across services.'],
      coverage, sourceGaps,
    };
  }
  const headline = entries.filter(({ definition }) => headlineMetrics[domain].includes(definition.id));
  const current = headline.filter(({ result }) =>
    ['measured', 'partial'].includes(result.status) && result.value !== null);
  const comparisons = current.flatMap(({ definition, result }) => {
    if (result.previous === null || result.value === null || result.previous === result.value) return [];
    return [{ definition, ...movement(result, definition) }];
  });
  const favorable = comparisons.filter(change => change.favorable === true).sort((a, b) => b.magnitude - a.magnitude);
  const unfavorable = comparisons.filter(change => change.favorable === false).sort((a, b) => b.magnitude - a.magnitude);
  const contextual = comparisons.filter(change => change.favorable === null).sort((a, b) => b.magnitude - a.magnitude);
  const findings: string[] = [];
  if (favorable[0]) findings.push(favorable[0].statement);
  if (unfavorable[0]) findings.push(unfavorable[0].statement);
  if (!unfavorable.length && contextual[0]) findings.push(contextual[0].statement);
  if (!findings.length) {
    if (current.some(({ result }) => result.previous !== null)) {
      findings.push('No change in the measures with comparable data versus the previous period.');
    } else if (current.length) {
      findings.push('Current readings are available, but there is not enough comparable history to assess direction.');
    } else {
      const reason = coverage.withheld
        ? `${coverage.withheld} measure${coverage.withheld === 1 ? ' is' : 's are'} withheld by privacy safeguards`
        : 'required measurements are unavailable';
      findings.push(`No current values support an assessment; ${reason}.`);
    }
  }
  const keyGaps = headline.filter(({ result }) => result.status === 'unavailable');
  if (keyGaps.length) {
    const names = keyGaps.slice(0, 2).map(({ definition }) => definition.name);
    const remainder = keyGaps.length - names.length;
    findings.push(`Key evidence gaps: ${names.join(', ')}${remainder ? `, +${remainder} more` : ''}.`);
  } else if (headline.some(({ result }) => result.status === 'suppressed')) {
    const withheld = headline.filter(({ result }) => result.status === 'suppressed').length;
    findings.push(`${withheld} featured measure${withheld === 1 ? ' is' : 's are'} withheld by privacy safeguards.`);
  }
  const tone: AnalysisTone = unfavorable.length ? 'watch' :
    favorable.length ? 'positive' :
    current.length || contextual.length ? 'neutral' : 'limited';
  return { domain, tone, findings, coverage, sourceGaps };
}

export function analyzeOverall(dashboard: Dashboard): OverallAnalysis {
  const domains: Framework[] = ['DORA', 'SPACE', 'Copilot'];
  const summaries = domains.map(domain => analyzeDomain(dashboard, domain));
  return {
    domains: summaries,
    available: summaries.reduce((count, summary) => count + summary.coverage.available + summary.coverage.partial, 0),
    total: summaries.reduce((count, summary) => count + summary.coverage.total, 0),
  };
}
