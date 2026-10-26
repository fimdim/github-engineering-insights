import { catalog } from './catalog.js';
import { DAY, dateKey, daysBetween, isRecord, numeric, records } from './types.js';
import type { Dashboard, Dataset, Fact, Filters, MetricDefinition, MetricResult, Point, Scope } from './types.js';

export function atPath(record: Record<string, unknown>, path: string): number | null {
  let value: unknown = record;
  for (const key of path.split('.')) {
    if (!isRecord(value)) return null;
    value = value[key];
  }
  return numeric(value);
}
export function quantile(values: number[], q = 0.5): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const text = (v: unknown) => typeof v === 'string' ? v : '';
const validTime = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const span = (a: unknown, b: unknown, unit = 3_600_000): number | null =>
  validTime(a) && validTime(b) && Date.parse(String(b)) >= Date.parse(String(a)) ? (Date.parse(String(b)) - Date.parse(String(a))) / unit : null;
const isHuman = (fact: Fact) => fact.data.bot !== true;
const inWindow = (value: unknown, filters: Filters) => validTime(value) && String(value).slice(0, 10) >= filters.from && String(value).slice(0, 10) <= filters.to;
const countByDay = (facts: Fact[], field: string): Point[] => {
  const days = new Map<string, number>();
  for (const fact of facts) {
    const day = text(fact.data[field]).slice(0, 10) || fact.day;
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, value]) => ({ day, value }));
};
const unique = (facts: Fact[]) => [...new Map(facts.map(f => [f.id, f])).values()];
function dailyMedians(points: Point[]): Point[] {
  const days = new Map<string, number[]>();
  for (const point of points) days.set(point.day, [...(days.get(point.day) ?? []), point.value]);
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, value: quantile(values)! }));
}

interface Measurement {
  value: number | null;
  sample?: number | null;
  numerator?: number;
  denominator?: number;
  p90?: number;
  series?: Point[];
  reason?: string;
  status?: MetricResult['status'];
  observed?: string[];
}
function duration(values: (number | null)[]): Measurement {
  const valid = values.filter((value): value is number => value !== null && value >= 0);
  return { value: quantile(valid), sample: valid.length, p90: quantile(valid, .9) ?? undefined };
}
function ratio(numerator: number, denominator: number): Measurement {
  return { value: denominator ? 100 * numerator / denominator : null, sample: denominator, numerator, denominator };
}
function sourcePrefix(id: string) {
  if (id.startsWith('dora.')) return 'deployments';
  if (id === 'copilot.seats') return 'seats';
  if (id === 'copilot.credits' || id === 'copilot.repeat') return 'users';
  if (id.startsWith('copilot.engagement-')) return 'copilotWindow';
  if (id.startsWith('copilot.')) return 'copilot';
  if (id.includes('ci-') || id === 'space.runs') return 'runs';
  if (id.includes('issue')) return 'issues';
  if (id === 'space.commits') return 'commits';
  if (['space.satisfaction', 'space.friction', 'space.sustainability', 'space.copilot-usefulness', 'space.response-rate', 'space.quality'].includes(id)) return 'surveys';
  if (id === 'space.incidents') return 'incidents';
  return 'pulls';
}

// Never expose team slices that would reveal a cohort smaller than five by subtraction.
export function safeTeams(facts: Fact[]): { id: string; name: string }[] {
  const users = new Set(facts.filter(f => f.source === 'users').map(f => String(f.data.user_id)));
  const teams = new Map<string, Set<string>>();
  for (const fact of facts.filter(f => f.source === 'teams')) {
    if (!users.has(String(fact.data.user_id))) continue;
    const key = String(fact.data.team_id);
    if (!teams.has(key)) teams.set(key, new Set());
    teams.get(key)!.add(String(fact.data.user_id));
  }
  const groups = [...teams.entries()];
  if (groups.some(([, members]) => members.size < 5 || (users.size - members.size > 0 && users.size - members.size < 5))) return [];
  for (const [, a] of groups) for (const [, b] of groups) {
    const difference = [...a].filter(id => !b.has(id)).length;
    if (difference > 0 && difference < 5) return [];
  }
  // Cross-day membership changes can reveal an individual through adjacent-window comparisons.
  for (const [id, members] of groups) {
    const byDay = new Map<string, Set<string>>();
    for (const f of facts.filter(f => f.source === 'teams' && String(f.data.team_id) === id)) {
      if (!byDay.has(f.day)) byDay.set(f.day, new Set());
      byDay.get(f.day)!.add(String(f.data.user_id));
    }
    if ([...byDay.values()].some(set => set.size !== members.size || [...members].some(user => !set.has(user)))) return [];
  }
  return groups.map(([id]) => ({ id, name: `Team ${id}` }));
}

function measure(def: MetricDefinition, facts: Fact[], filters: Filters, scope: Scope): Measurement {
  const all = (source: string) => unique(facts.filter(f => f.source === source));
  const selected = (source: string) => all(source).filter(f => f.day >= filters.from && f.day <= filters.to);
  const service = scope.services.find(s => s.id === filters.service);
  const byRepo = (items: Fact[]) => service ? items.filter(f => f.data.repository === service.repository) : items;
  const pulls = byRepo(all('pulls'));
  const merged = pulls.filter(f => inWindow(f.data.merged_at, filters));
  const reviews = byRepo(all('reviews')).filter(isHuman).filter(r => r.data.author_id !== r.data.user_id);
  const reviewOf = (pr: Fact) => reviews.filter(r => r.data.pull_id === pr.id && validTime(r.data.submitted_at) && (!pr.data.merged_at || String(r.data.submitted_at) <= String(pr.data.merged_at)));
  const deployments = service ? all('deployments').filter(f => f.data.service === service.id && inWindow(f.data.delivered_at, filters)) : [];
  const deployIDs = new Set(deployments.map(f => f.id));
  const incidents = service ? all('incidents').filter(f => f.data.service === service.id && inWindow(f.data.failed_at, filters)) : [];
  const allServiceDeployIDs = new Set(all('deployments').filter(f => f.data.service === service?.id).map(f => f.id));
  const linkedIncidents = incidents.filter(f => Array.isArray(f.data.failed_deployments) && f.data.failed_deployments.some(id => allServiceDeployIDs.has(String(id))));
  const hasObservation = service && all('observation').some(f => f.data.service === service.id && text(f.data.from) <= filters.from && text(f.data.to) >= filters.to);
  const dayCount = Math.round(daysBetween(filters.from, filters.to)) + 1;
  const id = def.id;
  if (def.grain === 'service' && !service) return { value: null, reason: 'Select one service. DORA describes a service, not a blended enterprise score.' };
  if (filters.team && def.framework !== 'Copilot' && def.kind !== 'survey') return { value: null, reason: 'Repository/service metrics cannot be attributed to a Copilot team.' };
  if (id === 'dora.frequency') {
    const counts = new Map(countByDay(deployments, 'delivered_at').map(p => [p.day, p.value]));
    const series = Array.from({ length: dayCount }, (_, i) => {
      const day = dateKey(Date.parse(filters.from) + i * DAY);
      return { day, value: counts.get(day) ?? 0 };
    });
    return { value: deployments.length / dayCount, sample: deployments.length, series };
  }
  if (id === 'dora.lead') {
    const changes = selected('changes').filter(f => f.data.service === service?.id && deployIDs.has(text(f.data.deployment)));
    const times = changes.map(f => span(f.data.committed_at, f.data.deployed_at));
    return { ...duration(times), series: dailyMedians(changes.filter(f => span(f.data.committed_at, f.data.deployed_at) !== null).map(f => ({ day: f.day, value: span(f.data.committed_at, f.data.deployed_at)! }))), reason: 'Only proven newly deployed commits are included; initial baseline and unresolved ancestry are excluded. Trend shows daily medians.' };
  }
  if (id === 'dora.recovery') {
    const result = duration(linkedIncidents.map(f => span(f.data.failed_at, f.data.recovered_at)));
    const unresolved = linkedIncidents.filter(f => !f.data.recovered_at).length;
    return { ...result, status: unresolved ? 'partial' : undefined, reason: unresolved ? `${unresolved} unresolved incident(s) excluded from recovery duration.` : undefined };
  }
  if (id === 'dora.failure' || id === 'dora.rework') {
    if (!hasObservation) return { value: null, reason: 'Import an explicit incident-observation coverage row for this service and complete window. No incidents is not evidence of zero failures.' };
    const field = id === 'dora.failure' ? 'failed_deployments' : 'rework_deployments';
    const relevantIncidents = all('incidents').filter(f => f.data.service === service?.id);
    const ids = new Set(relevantIncidents.flatMap(f => Array.isArray(f.data[field]) ? f.data[field].map(String).filter(v => deployIDs.has(v)) : []));
    return ratio(ids.size, deployments.length);
  }
  if (id === 'space.incidents') return { value: hasObservation ? linkedIncidents.length : null, sample: linkedIncidents.length, reason: hasObservation ? undefined : 'Incident observation coverage has not been declared.' };
  if (def.kind === 'survey') {
    const question = id === 'space.response-rate' ? null : id.replace('space.', '').replace('quality', 'quality-outcome');
    const surveys = all('surveys').filter(f => (!filters.team || text(f.data.team) === filters.team) && text(f.data.from) >= filters.from && text(f.data.to) <= filters.to && (!question || f.data.question === question));
    if (!surveys.length) return { value: null, reason: 'Import a comparable aggregate survey for this window and team.' };
    const teams = new Set(surveys.map(f => text(f.data.team)));
    if (!filters.team && teams.size > 1) return { value: null, reason: 'Select one survey team; cohort means are not combined across potentially overlapping teams.' };
    if (surveys.some(f => Number(f.data.responses) < 5)) return { value: null, status: 'suppressed', reason: 'A survey cohort has fewer than five responses.' };
    if (id === 'space.response-rate') {
      const populations = [...new Map(surveys.map(s => [`${s.data.from}:${s.data.to}:${s.data.responses}:${s.data.eligible}`, s])).values()];
      if (populations.length !== 1 || !populations[0]?.data.eligible) return { value: null, reason: 'Response rate requires one consistent survey population and period with a known eligible population.' };
      return ratio(Number(populations[0].data.responses), Number(populations[0].data.eligible));
    }
    if (new Set(surveys.map(f => `${f.data.min}:${f.data.max}`)).size > 1) return { value: null, reason: 'Survey scales differ. Compare a consistent scale.' };
    const responses = sum(surveys.map(f => Number(f.data.responses)));
    return { value: sum(surveys.map(f => Number(f.data.score) * Number(f.data.responses))) / responses, sample: responses, series: surveys.map(f => ({ day: text(f.data.to), value: Number(f.data.score) })), reason: `Survey scale ${surveys[0]!.data.min}-${surveys[0]!.data.max}.` };
  }
  if (id === 'space.pr-opened') {
    const items = pulls.filter(f => inWindow(f.data.created_at, filters));
    return { value: items.length, sample: items.length, series: countByDay(items, 'created_at') };
  }
  if (id === 'space.pr-merged') return { value: merged.length, sample: merged.length, series: countByDay(merged, 'merged_at') };
  if (id === 'space.pr-reviewed') return { value: new Set(reviews.filter(f => inWindow(f.data.submitted_at, filters)).map(f => f.data.pull_id)).size };
  if (id === 'space.review-response') return duration(pulls.filter(f => inWindow(f.data.created_at, filters)).map(pr => span(pr.data.created_at, reviewOf(pr).sort((a, b) => text(a.data.submitted_at).localeCompare(text(b.data.submitted_at)))[0]?.data.submitted_at)));
  if (id === 'space.review-coverage') return ratio(merged.filter(pr => reviewOf(pr).length > 0).length, merged.length);
  if (id === 'space.reviewers') {
    const count = new Set(reviews.filter(f => inWindow(f.data.submitted_at, filters)).map(f => f.data.user_id)).size;
    return count < 5 ? { value: null, status: 'suppressed', reason: 'Reviewer cohort is below five.' } : { value: count };
  }
  if (id === 'space.review-iterations') {
    const counts = merged.map(pr => reviewOf(pr).length).filter(v => v > 0);
    return { value: counts.length ? sum(counts) / counts.length : null, sample: counts.length };
  }
  if (id === 'space.pr-cycle') return { ...duration(merged.map(f => span(f.data.created_at, f.data.merged_at))), series: dailyMedians(merged.filter(f => span(f.data.created_at, f.data.merged_at) !== null).map(f => ({ day: text(f.data.merged_at).slice(0, 10), value: span(f.data.created_at, f.data.merged_at)! }))), reason: 'Trend shows daily medians. The overall median uses underlying PR durations, not daily medians.' };
  if (id === 'space.wip' || id === 'space.pr-age') {
    const end = `${filters.to}T23:59:59.999Z`;
    const open = pulls.filter(f => text(f.data.created_at) <= end && (!f.data.closed_at || text(f.data.closed_at) > end));
    return id === 'space.wip' ? { value: open.length, sample: open.length } : duration(open.map(f => span(f.data.created_at, end, DAY)));
  }
  if (id === 'space.pr-ready' || id === 'space.cross-team' || id === 'space.ci-duration') return { value: null, reason: def.caveat };
  if (id.startsWith('space.issues-') || id === 'space.issue-resolution') {
    const field = id === 'space.issues-opened' ? 'created_at' : 'closed_at';
    const items = byRepo(all('issues')).filter(f => inWindow(f.data[field], filters));
    return id === 'space.issue-resolution' ? duration(items.map(f => span(f.data.created_at, f.data.closed_at))) : { value: items.length, sample: items.length, series: countByDay(items, field) };
  }
  if (id === 'space.commits') {
    const items = byRepo(selected('commits'));
    return { value: items.length, sample: items.length, series: countByDay(items, 'committed_at') };
  }
  const runs = byRepo(selected('runs'));
  if (id === 'space.runs') return { value: runs.length, sample: runs.length, series: countByDay(runs, 'created_at') };
  if (id === 'space.ci-queue') return duration(runs.map(f => span(f.data.created_at, f.data.started_at, 60_000)));
  if (id === 'space.ci-failure') {
    const completed = runs.filter(f => f.data.status === 'completed');
    return ratio(completed.filter(f => f.data.conclusion === 'failure').length, completed.length);
  }
  if (id === 'space.ci-retry') return ratio(runs.filter(f => Number(f.data.attempt) > 1).length, runs.length);
  if (def.framework === 'Copilot') return copilotMeasure(def, facts, filters, scope);
  return { value: null, reason: 'Required source evidence is not available.' };
}

function copilotMeasure(def: MetricDefinition, facts: Fact[], filters: Filters, scope: Scope): Measurement {
  const smallEnterpriseAllowed = scope.kind === 'enterprise' && scope.allowSmallEnterpriseAggregates === true && !filters.team && !filters.service;
  const repositoryEvidence = filters.service && (def.field?.startsWith('pull_requests.') || def.id === 'copilot.review-acceptance');
  if (filters.service && !repositoryEvidence) return { value: null, reason: 'Copilot IDE usage is scope/team level, not attributable to a repository. Clear the service filter.' };
  const selected = facts.filter(f => f.day >= filters.from && f.day <= filters.to);
  const users = selected.filter(f => f.source === 'users');
  const memberships = selected.filter(f => f.source === 'teams');
  const matched = filters.team ? users.filter(user => memberships.some(m => m.day === user.day && m.data.user_id === user.data.user_id && String(m.data.team_id) === filters.team)) : users;
  let daily = selected.filter(f => f.source === 'copilot');
  if (repositoryEvidence) {
    const service = scope.services.find(s => s.id === filters.service);
    daily = selected.filter(f => f.source === 'repoCopilot' && f.data.repository === service?.repository);
  }
  if (filters.team) {
    if (!safeTeams(selected).some(t => t.id === filters.team)) return { value: null, status: 'suppressed', reason: 'Team slicing is withheld to protect small or changing/complementary cohorts.' };
    daily = aggregateUsers(matched);
  }
  if (def.id === 'copilot.seats') {
    if (filters.team) return { value: null, reason: 'Seat snapshot is not team-attributed.' };
    const snapshot = facts.filter(f => f.source === 'seats' && f.day >= filters.from && f.day <= filters.to).sort((a, b) => a.day.localeCompare(b.day)).at(-1);
    const seats = snapshot ? numeric(snapshot.data.seats) : null;
    return seats !== null && seats < 5 ? { value: null, status: 'suppressed', reason: 'Seat cohort below five.' } : { value: seats, reason: snapshot ? `Snapshot as of ${snapshot.day}; not a historical denominator.` : 'No seat snapshot inside the selected window.' };
  }
  if (['copilot.seat-active', 'copilot.inactive-seats'].includes(def.id)) return { value: null, reason: def.caveat };
  const safe = repositoryEvidence ? daily : daily.filter(f => numeric(f.data.daily_active_users) !== null && Number(f.data.daily_active_users) >= (smallEnterpriseAllowed ? 0 : 5));
  if (daily.length && !safe.length) return { value: null, status: 'suppressed', reason: 'Daily active cohorts are below five or not disclosed.' };
  if (def.id === 'copilot.repeat' || def.id === 'copilot.credits') {
    const byUser = new Map<string, Set<string>>();
    for (const user of matched) {
      const key = String(user.data.user_id);
      if (!byUser.has(key)) byUser.set(key, new Set());
      if (activeUser(user.data)) byUser.get(key)!.add(user.day);
    }
    const active = [...byUser.values()].filter(v => v.size);
    if (active.length < (smallEnterpriseAllowed ? 1 : 5)) return { value: null, status: matched.length ? 'suppressed' : 'unavailable', reason: 'Requires daily user reports and a qualifying active-user cohort.' };
    const expected = Math.round(daysBetween(filters.from, filters.to)) + 1;
    const observed = new Set(matched.map(f => f.day));
    if (observed.size < expected) return { value: null, reason: 'Daily user reports do not cover every selected day. A partial cohort would bias this metric.' };
    if (def.id === 'copilot.repeat') return ratio(active.filter(v => v.size >= 2).length, active.length);
    if (matched.some(f => numeric(f.data.ai_credits_used) === null)) return { value: null, reason: 'One or more daily user records omit ai_credits_used. Missing consumption is not zero.' };
    return { value: sum(matched.map(f => Number(f.data.ai_credits_used))), sample: active.length, observed: [...observed] };
  }
  if (def.id === 'copilot.completion-acceptance') {
    const items = safe.flatMap(f => records(f.data.totals_by_feature).filter(v => v.feature === 'code_completion'));
    if (!items.length) return { value: null, reason: 'No code_completion feature records; chat and agent events are not substitutes.' };
    if (items.some(v => numeric(v.code_acceptance_activity_count) === null || numeric(v.code_generation_activity_count) === null)) return { value: null, reason: 'Completion event counters are missing or incompatible.' };
    return { ...ratio(sum(items.map(v => Number(v.code_acceptance_activity_count))), sum(items.map(v => Number(v.code_generation_activity_count)))), observed: safe.map(f => f.day) };
  }
  if (def.id.startsWith('copilot.engagement-')) {
    if (filters.team) return { value: null, reason: 'Pre-aggregated feature engagement cannot be joined to a team.' };
    const window = facts.find(f => f.source === 'copilotWindow' && f.data.from === filters.from && f.data.to === filters.to);
    if (!window) return { value: null, reason: 'Select the exact 28-day period reported by GitHub. A partial window is not substituted.' };
    const engagement = isRecord(window.data.engagement) ? window.data.engagement : {};
    const entries = records(engagement.totals_by_feature);
    if (!smallEnterpriseAllowed && entries.some(e => Number(e.engaged_user_count) > 0 && Number(e.engaged_user_count) < 5)) return { value: null, status: 'suppressed', reason: 'Feature engagement contains a small cohort; all overlapping bins are withheld.' };
    const value = numeric(entries.find(e => e.feature === def.id.replace('copilot.engagement-', ''))?.engaged_user_count);
    return { value, reason: 'Users active on two or more days in the exact source 28-day window.' };
  }
  if (def.id.startsWith('copilot.cohort-')) {
    if (filters.team) return { value: null, reason: 'Source cohort classifications are not re-created from partial team telemetry.' };
    const row = [...safe].sort((a, b) => a.day.localeCompare(b.day)).at(-1);
    const phases = records(row?.data.totals_by_ai_adoption_phase);
    if (!smallEnterpriseAllowed && phases.some(p => Number(p.users_in_phase_28d) > 0 && Number(p.users_in_phase_28d) < 5)) return { value: null, status: 'suppressed', reason: 'One or more adoption cohorts are below five; all cohort bins are withheld.' };
    const phase = def.id.endsWith('passive') ? 'No Cohort' : `Phase ${def.id.at(-1)}`;
    return { value: numeric(phases.find(p => p.phase === phase)?.users_in_phase_28d), reason: 'Latest source-classified 28-day cohort. Association is not causal Copilot impact.' };
  }
  if (def.id === 'copilot.agent-adoption') {
    const row = [...safe].sort((a, b) => a.day.localeCompare(b.day)).at(-1);
    const agents = row ? numeric(row.data.monthly_active_agent_users) : null;
    const active = row ? numeric(row.data.monthly_active_users) : null;
    return agents === null || active === null ? { value: null, reason: 'Matching monthly active agent/user counters are missing.' } : ratio(agents, active);
  }
  if (def.id === 'copilot.review-acceptance') {
    const items = safe.map(f => [atPath(f.data, 'pull_requests.total_copilot_applied_suggestions'), atPath(f.data, 'pull_requests.total_copilot_suggestions')]);
    if (!items.length || items.some(v => v[0] === null || v[1] === null)) return { value: null, reason: 'Complete source-attributed review suggestion counters are required.' };
    return ratio(sum(items.map(v => v[0]!)), sum(items.map(v => v[1]!)));
  }
  if (def.id === 'copilot.cli-tokens-average' || def.id === 'copilot.app-tokens-average') {
    const prefix = def.id.includes('cli') ? 'totals_by_cli' : 'totals_by_copilot_app';
    const items = safe.map(f => [atPath(f.data, `${prefix}.token_usage.prompt_tokens_sum`), atPath(f.data, `${prefix}.token_usage.output_tokens_sum`), atPath(f.data, `${prefix}.request_count`)]);
    if (!items.length || items.some(v => v.some(n => n === null))) return { value: null, reason: 'Matching token sums and request counters are required.' };
    const denominator = sum(items.map(v => v[2]!));
    return { value: denominator ? sum(items.map(v => v[0]! + v[1]!)) / denominator : null, denominator };
  }
  if (def.id === 'copilot.agent-contribution') {
    const features = safe.flatMap(f => records(f.data.totals_by_feature));
    if (!features.length || features.some(f => numeric(f.loc_added_sum) === null || numeric(f.loc_deleted_sum) === null)) return { value: null, reason: 'Complete per-feature added/deleted line counters are required.' };
    const total = sum(features.map(f => Number(f.loc_added_sum) + Number(f.loc_deleted_sum)));
    const agent = sum(features.filter(f => ['agent', 'edit', 'agent_edit'].includes(String(f.feature))).map(f => Number(f.loc_added_sum) + Number(f.loc_deleted_sum)));
    return ratio(agent, total);
  }
  if (def.field) {
    const values = safe.map(f => ({ day: f.day, value: atPath(f.data, def.field!) })).filter((v): v is Point => v.value !== null);
    if (!values.length) return { value: null, reason: `The report does not include ${def.field} at this scope.` };
    const ordered = values.sort((a, b) => a.day.localeCompare(b.day));
    return {
      value: def.aggregation === 'sum' ? sum(values.map(v => v.value)) : ordered.at(-1)!.value,
      sample: null, series: ordered, observed: values.map(v => v.day),
      reason: def.aggregation === 'median' ? 'Latest reported daily median; not a median of daily medians.' : undefined,
    };
  }
  return { value: null, reason: 'Required report evidence is unavailable.' };
}

export function activeUser(data: Record<string, unknown>) {
  return Object.entries(data).some(([key, value]) => key.startsWith('used_') && value === true) ||
    Number(data.user_initiated_interaction_count) > 0 || Number(data.code_generation_activity_count) > 0;
}
export function aggregateUsers(users: Fact[]): Fact[] {
  const byDay = new Map<string, Fact[]>();
  for (const user of unique(users)) {
    if (!byDay.has(user.day)) byDay.set(user.day, []);
    byDay.get(user.day)!.push(user);
  }
  const add = (target: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith('_id') || key === 'user_login' || key.startsWith('distinct_') || key.includes('version')) continue;
      if (typeof value === 'number') target[key] = Number(target[key] ?? 0) + value;
      else if (Array.isArray(value)) {
        const existing = records(target[key]);
        const output = [...existing];
        for (const entry of records(value)) {
          const dimensions = Object.entries(entry).filter(([, v]) => typeof v === 'string');
          let match = output.find(e => dimensions.every(([k, v]) => e[k] === v));
          if (!match) { match = Object.fromEntries(dimensions); output.push(match); }
          add(match, entry);
        }
        target[key] = output;
      } else if (isRecord(value)) {
        const child = isRecord(target[key]) ? target[key] : {};
        add(child, value);
        target[key] = child;
      }
    }
  };
  return [...byDay].map(([day, rows]) => {
    const data: Record<string, unknown> = { daily_active_users: rows.filter(f => activeUser(f.data)).length };
    for (const user of rows) add(data, user.data);
    return { source: 'copilot', day, id: day, data };
  });
}

export function calculate(dataset: Dataset, scope: Scope, filters: Filters, demo = false): Dashboard {
  const expectedDays = Math.round(daysBetween(filters.from, filters.to)) + 1;
  const previousTo = dateKey(Date.parse(filters.from) - DAY);
  const previousFrom = dateKey(Date.parse(filters.from) - expectedDays * DAY);
  const metrics = catalog.map(def => {
    let measured = measure(def, dataset.facts, filters, scope);
    let prefix = sourcePrefix(def.id);
    if (filters.service && def.framework === 'Copilot' && (def.field?.startsWith('pull_requests.') || def.id === 'copilot.review-acceptance')) prefix = 'repoCopilot';
    const service = scope.services.find(s => s.id === filters.service);
    const statuses = dataset.statuses.filter(s => (s.source === prefix || s.source.startsWith(`${prefix}:`)) && (!service || !s.source.includes(':') || s.source.endsWith(`:${service.repository}`)));
    const githubMetric = ['deployments', 'pulls', 'runs', 'issues', 'commits'].includes(prefix);
    if (githubMetric && (!statuses.length || statuses.every(s => s.state !== 'ready' && s.state !== 'empty'))) {
      measured = { value: null, reason: statuses[0]?.message ?? `Connect and sync ${prefix} first.` };
    }
    const expectedSources = githubMetric ? (service ? 1 : scope.repositories.length) : 1;
    const statusesIncomplete = statuses.length < expectedSources || statuses.some(s => !['ready', 'empty'].includes(s.state) || (s.from && s.from > filters.from) || (s.to && s.to < filters.to));
    const observedDays = measured.observed ? new Set(measured.observed).size : statuses.length && !statusesIncomplete ? expectedDays : 0;
    let status: MetricResult['status'] = measured.status ?? (measured.value === null ? 'unavailable' : 'measured');
    if (measured.value !== null && (statusesIncomplete || (measured.observed && observedDays < expectedDays))) status = 'partial';
    const previousMeasurement = measure(def, dataset.facts, { ...filters, from: previousFrom, to: previousTo }, scope);
    const previousCovered = statuses.length > 0 && statuses.every(s => ['ready', 'empty'].includes(s.state) && s.from && s.from <= previousFrom && s.to && s.to >= previousTo);
    return {
      id: def.id, value: measured.value, previous: previousCovered && status !== 'suppressed' ? previousMeasurement.value : null,
      status, reason: measured.reason ?? (status === 'partial' ? 'Incomplete source coverage for this window.' : status === 'unavailable' ? `Required ${def.source} evidence is unavailable.` : def.caveat),
      sample: measured.value === null && status === 'suppressed' ? null : measured.sample ?? null,
      numerator: status === 'suppressed' ? undefined : measured.numerator, denominator: status === 'suppressed' ? undefined : measured.denominator, p90: status === 'suppressed' ? undefined : measured.p90,
      series: measured.value === null ? [] : measured.series ?? [],
      coverage: { from: filters.from, to: filters.to, expectedDays, observedDays },
    } satisfies MetricResult;
  });
  const smallEnterpriseAllowed = scope.kind === 'enterprise' && scope.allowSmallEnterpriseAggregates === true && !filters.team && !filters.service;
  const copilotRows = dataset.facts.filter(f => f.source === 'copilot' && f.day >= filters.from && f.day <= filters.to && numeric(f.data.daily_active_users) !== null && Number(f.data.daily_active_users) >= (smallEnterpriseAllowed ? 0 : 5));
  const breakdowns: Dashboard['breakdowns'] = [];
  if (!filters.service && !filters.team) {
    for (const [dimension, field, nameKey] of [
      ['Features', 'totals_by_feature', 'feature'], ['Editors', 'totals_by_ide', 'ide'],
      ['Languages', 'totals_by_language_feature', 'language'], ['Models', 'totals_by_model_feature', 'model'],
      ['Custom agents', 'totals_by_custom_agent', 'custom_agent'], ['MCP servers', 'totals_by_mcp', 'mcp'],
      ['Skills', 'totals_by_skill', 'skill'], ['Plugins', 'totals_by_plugin', 'plugin'],
      ['Slash commands', 'totals_by_slash_cmd', 'slash_cmd'],
    ]) {
      const totals = new Map<string, number>();
      for (const row of copilotRows) for (const entry of records(row.data[field!])) {
        const value = numeric(entry.user_initiated_interaction_count) ?? numeric(entry.interaction_count) ?? numeric(entry.code_generation_activity_count);
        if (value === null) continue;
        const name = text(entry[nameKey!]) || 'Unknown';
        totals.set(name, (totals.get(name) ?? 0) + value);
      }
      if (totals.size) breakdowns.push({ dimension: dimension!, entries: [...totals].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value) });
    }
  }
  return {
    mode: demo ? 'demo' : 'live', scope, filters, metrics, sources: dataset.statuses,
    // Team breakdowns are intentionally conservative; only stable, subtraction-safe cohorts appear.
    teams: safeTeams(dataset.facts.filter(f => f.day >= filters.from && f.day <= filters.to)),
    breakdowns, notices: [
      ...(smallEnterpriseAllowed ? ['Small-cohort enterprise aggregates are explicitly enabled for this local scope. Outputs may reveal individual activity in very small enterprises; do not share exports as anonymous data. Team and survey protections remain unchanged.'] : []),
      'Activity is not productivity. Copilot usage is not proof of delivery impact.',
      'DORA is service-scoped. Team memberships overlap; team totals are not additive.',
      smallEnterpriseAllowed ? 'Small enterprise-wide Copilot aggregates are visible by explicit opt-in. Other small, changing, or complementary cohorts remain withheld. Missing data is never converted to zero.' : 'Small, changing, or complementary cohorts are withheld. Missing data is never converted to zero.',
    ],
  };
}
