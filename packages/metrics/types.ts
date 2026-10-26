export type Framework = 'DORA' | 'SPACE' | 'Copilot';
export type Dimension = 'Throughput' | 'Instability' | 'Satisfaction' | 'Performance' | 'Activity' | 'Collaboration' | 'Efficiency' | 'Adoption' | 'Usage' | 'Code generation' | 'Agent activity';
export type Status = 'measured' | 'partial' | 'unavailable' | 'suppressed';
export type SourceState = 'ready' | 'empty' | 'partial' | 'forbidden' | 'unauthenticated' | 'unsupported' | 'error' | 'syncing' | 'cancelled';
export interface MetricDefinition {
  id: string;
  name: string;
  framework: Framework;
  dimension: Dimension;
  unit: 'count' | 'percent' | 'hours' | 'minutes' | 'days' | 'per day' | 'score' | 'credits' | 'tokens';
  description: string;
  formula: string;
  source: string;
  caveat: string;
  direction: 'lower' | 'higher' | 'context';
  kind: 'direct' | 'proxy' | 'survey';
  grain: 'service' | 'repository' | 'scope' | 'team';
  field?: string;
  aggregation?: 'sum' | 'latest' | 'median' | 'mean';
}
export interface Point { day: string; value: number }
export interface MetricResult {
  id: string;
  value: number | null;
  previous: number | null;
  status: Status;
  reason: string;
  sample: number | null;
  numerator?: number;
  denominator?: number;
  p90?: number;
  series: Point[];
  coverage: { from: string; to: string; observedDays: number; expectedDays: number };
}
export interface Service {
  id: string;
  name: string;
  repository: string;
  environment: string;
}
export interface Scope {
  id: string;
  kind: 'organization' | 'enterprise';
  slug: string;
  repositories: string[];
  services: Service[];
  allowSmallEnterpriseAggregates?: boolean;
}
export interface Settings { scopes: Scope[] }
export interface Fact {
  source: string;
  id: string;
  day: string;
  data: Record<string, unknown>;
}
export interface SourceStatus {
  source: string;
  state: SourceState;
  message: string;
  updatedAt: string;
  from?: string;
  to?: string;
}
export interface Dataset { facts: Fact[]; statuses: SourceStatus[] }
export interface Filters {
  scope: string;
  service: string;
  team: string;
  from: string;
  to: string;
}
export interface Dashboard {
  mode: 'demo' | 'live';
  scope: Scope;
  filters: Filters;
  metrics: MetricResult[];
  sources: SourceStatus[];
  teams: { id: string; name: string }[];
  breakdowns: { dimension: string; entries: { name: string; value: number }[] }[];
  notices: string[];
}
export const DAY = 86_400_000;
export const dateKey = (date: Date | number | string) => new Date(date).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const records = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(isRecord) : [];
export const numeric = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
