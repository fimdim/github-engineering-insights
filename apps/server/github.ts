import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../../packages/data/store.js';
import { dateKey, DAY, isRecord, numeric, records } from '../../packages/metrics/types.js';
import type { Fact, Scope, SourceState } from '../../packages/metrics/types.js';

const execute = promisify(execFile);
export class ConnectorError extends Error {
  constructor(readonly state: SourceState, message: string) { super(message); }
}
export type GitHubRequest = (path: string, signal?: AbortSignal) => Promise<unknown>;
type ReportDownloader = (link: string, signal: AbortSignal) => AsyncIterable<Record<string, unknown>>;
interface SourceOutcome { count: number; missingDays: string[] }
export const githubRequest: GitHubRequest = async (path, signal) => {
  if (!/^(user|orgs\/|enterprises\/|repos\/)/.test(path)) throw new ConnectorError('error', 'Invalid GitHub API path.');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await execute('gh', ['api', '--hostname', 'github.com', '-H', 'X-GitHub-Api-Version: 2026-03-10', '-H', 'Accept: application/vnd.github+json', '--method', 'GET', path], {
        signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
      });
      return stdout.trim() ? JSON.parse(stdout) as unknown : null;
    } catch (error) {
      if (signal?.aborted) throw new ConnectorError('cancelled', 'Sync cancelled. Completed checkpoints were retained.');
      const details = error instanceof Error ? error.message : '';
      const status = details.match(/HTTP (\d{3})/)?.[1];
      if ((status === '429' || status?.startsWith('5')) && attempt < 2) {
        await delay(1500 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (details.includes('ENOENT') || details.includes('gh auth login') || status === '401') throw new ConnectorError('unauthenticated', 'GitHub CLI is unavailable or not signed in. Run gh auth login for github.com in your terminal.');
      if (status === '403') throw new ConnectorError('forbidden', 'GitHub denied access. Check read permissions, Copilot metrics policy, SSO authorization, and rate limits; no permissions were changed.');
      if (status === '404') throw new ConnectorError('unsupported', 'This source was not found or is inaccessible to the signed-in account.');
      throw new ConnectorError('error', status ? `GitHub returned HTTP ${status}. Retry sync after checking the source.` : 'GitHub CLI request failed or timed out. Check connectivity and gh auth status.');
    }
  }
  throw new ConnectorError('error', 'GitHub retry limit reached.');
};

export async function pages(request: GitHubRequest, path: string, key?: string, stop?: (rows: Record<string, unknown>[]) => boolean, signal?: AbortSignal) {
  const output: Record<string, unknown>[] = [];
  for (let page = 1; page <= 1000; page++) {
    signal?.throwIfAborted();
    const result = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, signal);
    const rows = records(key && isRecord(result) ? result[key] : result);
    if (!Array.isArray(key && isRecord(result) ? result[key] : result)) throw new ConnectorError('error', 'GitHub response has an incompatible list schema.');
    output.push(...rows);
    if (rows.length < 100 || stop?.(rows)) return output;
  }
  throw new ConnectorError('error', 'Pagination safety limit reached; narrow repository scope.');
}

const str = (value: unknown) => typeof value === 'string' ? value : '';
const obj = (value: unknown) => isRecord(value) ? value : {};
const required = (value: unknown, name: string) => {
  if ((typeof value !== 'string' || !value) && typeof value !== 'number') throw new ConnectorError('error', `GitHub response is missing ${name}.`);
  return String(value);
};

export interface SyncProgress {
  running: boolean;
  scope: string | null;
  task: string;
  completed: number;
  failures: number;
  startedAt: string | null;
}
export class SyncCoordinator {
  progress: SyncProgress = { running: false, scope: null, task: 'Not synced', completed: 0, failures: 0, startedAt: null };
  private abort?: AbortController;
  private active?: Promise<void>;
  constructor(private store: Store, private request: GitHubRequest = githubRequest, private downloader: ReportDownloader = downloadReport) {}
  start(scope: Scope) {
    if (this.progress.running) throw new Error('A sync is already running. Cancel it before starting another.');
    this.abort = new AbortController();
    this.progress = { running: true, scope: scope.id, task: 'Checking connections', completed: 0, failures: 0, startedAt: new Date().toISOString() };
    this.active = this.run(scope, this.abort.signal).finally(() => {
      this.progress.running = false;
      this.progress.task = this.abort?.signal.aborted ? 'Cancelled; checkpoints retained' : this.progress.failures ? 'Finished with source gaps' : 'Sync complete';
    });
    // run() records failures per source and handles cancellation; this guards only unexpected coordinator errors.
    this.active.catch(() => {
      this.progress.failures++;
      this.progress.task = 'Sync failed. Inspect source status and retry.';
      this.store.status(scope.id, { source: 'sync', state: 'error', message: 'Unexpected sync failure. Source checkpoints were retained.', updatedAt: new Date().toISOString() });
    });
  }
  cancel() { this.abort?.abort(); }
  async settled() { await this.active; }
  private async run(scope: Scope, signal: AbortSignal) {
    const to = dateKey(Date.now() - DAY);
    const from = dateKey(Date.now() - 90 * DAY);
    const copilotFrom = dateKey(Date.now() - 28 * DAY);
    const step = async (source: string, since: string, fn: () => Promise<number | SourceOutcome>) => {
      if (signal.aborted) return;
      this.progress.task = source;
      this.store.status(scope.id, { source, state: 'syncing', message: 'Fetching source metadata', updatedAt: new Date().toISOString(), from: since, to });
      try {
        const result = await fn();
        const count = typeof result === 'number' ? result : result.count;
        const missingDays = typeof result === 'number' ? [] : result.missingDays;
        const state = missingDays.length ? count ? 'partial' : 'unsupported' : count ? 'ready' : 'empty';
        const message = missingDays.length
          ? `${count} metadata records retained; no report available on ${missingDays.length} day(s), including ${missingDays.slice(0, 3).join(', ')}. All dates were checked. Missing reports are not measured zeros and will be retried.`
          : `${count} metadata records observed.`;
        if (missingDays.length) this.progress.failures++;
        this.store.status(scope.id, { source, state, message, updatedAt: new Date().toISOString(), from: missingDays.length ? undefined : since, to: missingDays.length ? undefined : to });
        this.progress.completed++;
      } catch (error) {
        this.progress.failures++;
        this.store.status(scope.id, {
          source, state: signal.aborted ? 'cancelled' : error instanceof ConnectorError ? error.state : 'error',
          message: signal.aborted ? 'Sync cancelled; completed records retained.' : error instanceof ConnectorError ? error.message : 'Source schema or processing failed. No successful coverage is claimed; retry after checking compatibility.',
          updatedAt: new Date().toISOString(),
        });
      }
    };
    for (const repository of scope.repositories) {
      const base = `repos/${repository}`;
      const old = (rows: Record<string, unknown>[]) => rows.every(row => str(row.updated_at || row.created_at).slice(0, 10) < from);
      await step(`pulls:${repository}`, from, async () => {
        const open = await pages(this.request, `${base}/pulls?state=open&sort=updated&direction=desc`, undefined, undefined, signal);
        const closed = await pages(this.request, `${base}/pulls?state=closed&sort=updated&direction=desc`, undefined, old, signal);
        const rows = [...new Map([...open, ...closed].filter(row => row.state === 'open' || str(row.updated_at).slice(0, 10) >= from).map(row => [row.id, row])).values()];
        const currentIDs = new Set(rows.map(row => `${repository}:${row.number}`));
        for (const prior of this.store.dataset(scope.id).facts.filter(f => f.source === 'pulls' && f.data.repository === repository && !f.data.closed_at && f.day < from && !currentIDs.has(f.id))) {
          this.store.removeFact(scope.id, 'pulls', prior.id);
        }
        for (const row of rows) {
          const id = `${repository}:${required(row.number, 'pull number')}`;
          const author = obj(row.user);
          this.store.put(scope.id, { source: 'pulls', id, day: str(row.created_at).slice(0, 10), data: {
            repository, created_at: row.created_at, closed_at: row.closed_at, merged_at: row.merged_at,
            draft: row.draft, bot: author.type === 'Bot', author_id: author.id,
          } });
          const reviews = await pages(this.request, `${base}/pulls/${row.number}/reviews`, undefined, undefined, signal);
          for (const review of reviews) {
            if (!review.submitted_at || review.state === 'PENDING') continue;
            const user = obj(review.user);
            this.store.put(scope.id, { source: 'reviews', id: `${repository}:${required(review.id, 'review id')}`, day: str(review.submitted_at).slice(0, 10), data: {
              repository, pull_id: id, submitted_at: review.submitted_at, state: review.state,
              user_id: user.id, author_id: author.id, bot: user.type === 'Bot',
            } });
          }
        }
        return rows.length;
      });
      await step(`issues:${repository}`, from, async () => {
        const rows = await pages(this.request, `${base}/issues?state=all&since=${from}T00:00:00Z`, undefined, undefined, signal);
        const oldOpen = await pages(this.request, `${base}/issues?state=open`, undefined, undefined, signal);
        const issues = [...new Map([...rows, ...oldOpen].filter(row => !row.pull_request).map(row => [row.id, row])).values()];
        const currentIDs = new Set(issues.map(row => `${repository}:${row.id}`));
        for (const prior of this.store.dataset(scope.id).facts.filter(f => f.source === 'issues' && f.data.repository === repository && !f.data.closed_at && f.day < from && !currentIDs.has(f.id))) {
          this.store.removeFact(scope.id, 'issues', prior.id);
        }
        this.store.putMany(scope.id, issues.map(row => ({ source: 'issues', id: `${repository}:${row.id}`, day: str(row.created_at).slice(0, 10), data: {
          repository, created_at: row.created_at, closed_at: row.closed_at, bot: obj(row.user).type === 'Bot',
        } })));
        return issues.length;
      });
      await step(`runs:${repository}`, from, async () => {
        const rows = await pages(this.request, `${base}/actions/runs?created=%3E%3D${from}`, 'workflow_runs', undefined, signal);
        this.store.putMany(scope.id, rows.map(row => ({ source: 'runs', id: `${repository}:${row.id}`, day: str(row.created_at).slice(0, 10), data: {
          repository, created_at: row.created_at, started_at: row.run_started_at, status: row.status, conclusion: row.conclusion, attempt: row.run_attempt,
        } })));
        return rows.length;
      });
      await step(`commits:${repository}`, from, async () => {
        const rows = await pages(this.request, `${base}/commits?since=${from}T00:00:00Z`, undefined, undefined, signal);
        this.store.putMany(scope.id, rows.map(row => {
          const committed = obj(obj(row.commit).committer).date;
          return { source: 'commits', id: `${repository}:${row.sha}`, day: str(committed).slice(0, 10), data: {
            repository, committed_at: committed, bot: obj(row.author).type === 'Bot',
          } };
        }));
        return rows.length;
      });
      await step(`deployments:${repository}`, from, async () => {
        const services = scope.services.filter(service => service.repository === repository);
        if (!services.length) throw new ConnectorError('unsupported', 'Map a production service/environment for this repository first.');
        const rows = await pages(this.request, `${base}/deployments`, undefined, rows => rows.some(row => str(row.created_at).slice(0, 10) < from), signal);
        let count = 0;
        for (const service of services) {
          const production: { id: string; sha: string; at: string }[] = [];
          for (const row of rows.filter(row => row.environment === service.environment)) {
            const statuses = await pages(this.request, `${base}/deployments/${row.id}/statuses`, undefined, undefined, signal);
            const delivered = statuses.filter(status => status.state === 'success').sort((a, b) => str(a.created_at).localeCompare(str(b.created_at)))[0];
            if (!delivered) continue;
            const id = `${repository}:${required(row.id, 'deployment id')}`;
            const at = required(delivered.created_at, 'deployment timestamp');
            production.push({ id, sha: required(row.sha, 'deployment SHA'), at });
            this.store.put(scope.id, { source: 'deployments', id: `${service.id}:${id}`, day: at.slice(0, 10), data: { service: service.id, repository, delivered_at: at, deployment_id: id, sha: row.sha } });
            count++;
          }
          production.sort((a, b) => a.at.localeCompare(b.at));
          const seen = new Set<string>();
          for (let index = 1; index < production.length; index++) {
            const previous = production[index - 1]!, current = production[index]!;
            if (current.sha === previous.sha) continue;
            const comparison = await this.request(`${base}/compare/${previous.sha}...${current.sha}?per_page=100&page=1`, signal);
            if (!isRecord(comparison) || comparison.status === 'diverged' || comparison.status === 'behind') {
              throw new ConnectorError('error', 'Deployment ancestry is divergent/rolled back. Deployment metadata was retained but lead-time coverage is incomplete.');
            }
            const total = numeric(comparison.total_commits);
            let commits = records(comparison.commits);
            if (total === null) throw new ConnectorError('error', 'Compare response lacks commit coverage.');
            for (let page = 2; commits.length < total && page <= 1000; page++) {
              const next = await this.request(`${base}/compare/${previous.sha}...${current.sha}?per_page=100&page=${page}`, signal);
              const part = records(obj(next).commits);
              if (!part.length) throw new ConnectorError('error', 'Compare pagination is incomplete; lead time is partial.');
              commits = commits.concat(part);
            }
            if (commits.length < total) throw new ConnectorError('error', 'Compare pagination safety limit reached.');
            for (const commit of commits) {
              const key = `${service.id}:${required(commit.sha, 'commit SHA')}`;
              if (seen.has(key)) continue;
              seen.add(key);
              this.store.put(scope.id, { source: 'changes', id: key, day: current.at.slice(0, 10), data: {
                service: service.id, repository, deployment: `${service.id}:${current.id}`,
                committed_at: obj(obj(commit.commit).committer).date, deployed_at: current.at,
              } });
            }
          }
        }
        return count;
      });
    }
    const base = scope.kind === 'enterprise' ? `enterprises/${scope.slug}` : `orgs/${scope.slug}`;
    await step('seats', dateKey(Date.now()), async () => {
      if (scope.kind === 'enterprise') throw new ConnectorError('unsupported', 'Seat snapshots currently require organization scope; enterprise usage reports remain available.');
      const result = await this.request(`${base}/copilot/billing/seats?per_page=1`, signal);
      const seats = isRecord(result) ? numeric(result.total_seats) : null;
      if (seats === null) throw new ConnectorError('error', 'Seat response has an incompatible schema.');
      this.store.put(scope.id, { source: 'seats', id: dateKey(Date.now()), day: dateKey(Date.now()), data: { seats } });
      return seats;
    });
    const aggregate = scope.kind === 'enterprise' ? 'enterprise-1-day' : 'organization-1-day';
    for (const [source, report] of [['copilot', aggregate], ['users', 'users-1-day'], ['teams', 'user-teams-1-day'], ['repoCopilot', 'repos-1-day']] as const) {
      await step(source, copilotFrom, async () => {
        let count = 0;
        const missingDays: string[] = [];
        for (let time = Date.parse(copilotFrom); time <= Date.parse(to); time += DAY) {
          const day = dateKey(time);
          if (this.store.hasCheckpoint(scope.id, source, day) && time < Date.parse(to) - 3 * DAY) continue;
          const response = await this.request(`${base}/copilot/metrics/reports/${report}?day=${day}`, signal);
          const links = reportLinks(response);
          if (links === null) {
            // Keep checking newer dates; absent reports are neither observed zeros nor checkpoints.
            missingDays.push(day);
            continue;
          }
          const facts: Fact[] = [];
          let bytes = 0;
          for (const link of links) {
            for await (const row of this.downloader(link, signal)) {
              bytes += Buffer.byteLength(JSON.stringify(row));
              if (bytes > 128 * 1024 * 1024 || facts.length >= 250_000) throw new ConnectorError('error', 'Daily report exceeds local processing limits. Use a narrower organization scope.');
              facts.push(...normalizeReport(source, row, day, scope));
            }
          }
          this.store.replaceDay(scope.id, source, day, facts);
          count += facts.length;
        }
        count = this.store.dataset(scope.id).facts.filter(f => f.source === source && f.day >= copilotFrom && f.day <= to).length;
        return { count, missingDays };
      });
    }
    await step('copilotWindow', copilotFrom, async () => {
      const report = scope.kind === 'enterprise' ? 'enterprise-28-day' : 'organization-28-day';
      const response = await this.request(`${base}/copilot/metrics/reports/${report}/latest`, signal);
      const links = reportLinks(response);
      if (links === null) throw new ConnectorError('unsupported', 'The latest 28-day report is not available. Retry after GitHub publishes a report.');
      let count = 0;
      for (const link of links) {
        for await (const row of this.downloader(link, signal)) {
          const start = required(row.report_start_day, 'report start day'), end = required(row.report_end_day, 'report end day');
          if (!isRecord(row.copilot_feature_engagement)) continue;
          this.store.put(scope.id, { source: 'copilotWindow', id: `${start}:${end}`, day: end, data: { from: start, to: end, engagement: telemetryOnly(row.copilot_feature_engagement) } });
          count++;
        }
      }
      return count;
    });
    this.store.prune(scope.id);
  }
}

export function reportLinks(response: unknown): string[] | null {
  // GitHub uses both HTTP 204 (empty body) and JSON "" for unavailable report families/dates.
  if (response === null || response === '') return null;
  if (!isRecord(response) || !Array.isArray(response.download_links) || response.download_links.length > 16) {
    throw new ConnectorError('error', 'Report-download response has an incompatible schema or exceeds 16 parts.');
  }
  if (!response.download_links.every((link): link is string => typeof link === 'string' && link.length > 0)) {
    throw new ConnectorError('error', 'Invalid report download link.');
  }
  if (!response.download_links.length) return null;
  return response.download_links;
}

export function validateReportUrl(value: string): URL {
  const url = new URL(value);
  const hosts = ['copilot-reports.github.com', 'reports.github.com', 'api.github.com', 'github.com'];
  const blob = /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/i.test(url.hostname);
  const s3 = /^[a-z0-9.-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      (!hosts.includes(url.hostname) && !blob && !s3)) throw new ConnectorError('error', 'Report download host is not in the GitHub/Azure Blob/S3 delivery allowlist. No request was sent.');
  return url;
}
export async function* downloadReport(link: string, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  let url = validateReportUrl(link);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ConnectorError('error', 'Report redirect lacks a destination.');
      url = validateReportUrl(new URL(location, url).href);
      await response.body?.cancel();
      continue;
    }
    if (!response.ok || !response.body) throw new ConnectorError('error', `Report download returned HTTP ${response.status}. Signed URLs were not logged.`);
    let bytes = 0;
    const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line);
        if (bytes > 128 * 1024 * 1024 || line.length > 8 * 1024 * 1024) throw new ConnectorError('error', 'Report exceeded the bounded download limit.');
        if (!line.trim()) continue;
        const row: unknown = JSON.parse(line);
        for (const entry of Array.isArray(row) ? row : [row]) {
          if (!isRecord(entry)) throw new ConnectorError('error', 'Report row is not an object.');
          yield entry;
        }
      }
    } finally { lines.close(); stream.destroy(); }
    return;
  }
  throw new ConnectorError('error', 'Report exceeded redirect limit.');
}

const dimensionKeys = new Set(['feature', 'ide', 'language', 'model', 'custom_agent', 'mcp', 'plugin', 'skill', 'slash_cmd', 'phase', 'agent_name']);
function telemetryOnly(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'user_id' || key === 'team_id' || key === 'repository_id') { result[key] = value; continue; }
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
    else if (typeof value === 'boolean' || value === null) result[key] = value;
    else if (typeof value === 'string' && dimensionKeys.has(key)) result[key] = value.slice(0, 100);
    else if (isRecord(value)) result[key] = telemetryOnly(value);
    else if (Array.isArray(value)) result[key] = records(value).map(telemetryOnly);
  }
  return result;
}
export function normalizeReport(source: string, row: Record<string, unknown>, requestedDay: string, scope: Scope): Fact[] {
  if (Array.isArray(row.day_totals)) return records(row.day_totals).flatMap(day => normalizeReport(source, day, requestedDay, scope));
  const day = required(row.day, 'report day');
  if (day !== requestedDay) throw new ConnectorError('error', 'Report day does not match the requested daily window.');
  const data = telemetryOnly(row);
  if (source === 'copilot' && numeric(row.daily_active_users) === null) throw new ConnectorError('error', 'Aggregate report lacks daily_active_users.');
  let identity = day;
  if (source === 'users') identity = `${day}:${required(row.user_id, 'user ID')}`;
  if (source === 'teams') identity = `${day}:${required(row.user_id, 'user ID')}:${required(row.team_id, 'team ID')}`;
  if (source === 'repoCopilot') {
    identity = `${day}:${required(row.repo_id, 'repository ID')}`;
    const repository = `${required(row.repo_owner_name, 'repository owner')}/${required(row.repo_name, 'repository name')}`;
    if (!scope.repositories.includes(repository)) return [];
    data.repository = repository;
  }
  // Never persist raw report download URLs, usernames, organization names, prompts, or source text.
  return [{ source, id: `${scope.id}:${identity}`, day, data }];
}
