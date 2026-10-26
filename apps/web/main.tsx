import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronDown, CircleHelp,
  Code2, Database, Download, ExternalLink, GitBranch, Layers3, LayoutDashboard,
  LoaderCircle, Moon, PanelLeftClose, RefreshCw, Search, Settings2, ShieldCheck,
  Sparkles, Sun, Upload, X, AlertCircle, Cable, Fingerprint, Telescope,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Dashboard, Dimension, Filters, Framework, MetricDefinition, MetricResult, Point, Scope, Settings } from '../../packages/metrics/types.js';
import { DAY, dateKey } from '../../packages/metrics/types.js';
import { catalog, dimensions } from '../../packages/metrics/catalog.js';
import { analyzeDomain, analyzeOverall } from '../../packages/metrics/analysis.js';
import { api, session } from './api.js';
import './style.css';

type Page = 'overview' | 'dora' | 'space' | 'copilot' | 'catalog' | 'data';
const navigation: { id: Page; name: string; icon: LucideIcon }[] = [
  { id: 'overview', name: 'Overview', icon: LayoutDashboard },
  { id: 'dora', name: 'DORA delivery', icon: GitBranch },
  { id: 'space', name: 'SPACE experience', icon: Layers3 },
  { id: 'copilot', name: 'Copilot adoption', icon: Sparkles },
  { id: 'catalog', name: 'Metric catalog', icon: BookOpen },
  { id: 'data', name: 'Connections & data', icon: Database },
];
const titles: Record<Page, [string, string]> = {
  overview: ['Delivery overview', 'Delivery outcomes, developer experience, and AI adoption. In context.'],
  dora: ['Software delivery', 'Five measures of how safely and efficiently a service reaches production.'],
  space: ['Developer experience', 'A multidimensional view. Because activity alone is not productivity.'],
  copilot: ['Copilot adoption', 'Understand engagement and usage. Keep outcomes and attribution separate.'],
  catalog: ['The metric catalog', 'Know what each number means, where it comes from, and what it cannot tell you.'],
  data: ['Connections & data', 'Your evidence, on your machine. Connect sources and make coverage explicit.'],
};
const fallbackFilters: Filters = { scope: 'demo', service: '', team: '', from: dateKey(Date.now() - 28 * DAY), to: dateKey(Date.now() - DAY) };
function savedFilters(): Filters {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('observatory.filters') ?? 'null');
    if (value && typeof value === 'object' && Object.values(value).every(v => typeof v === 'string') && 'scope' in value) {
      // Always roll the date window forward; persist scope/service/team, not a stale default period.
      const stored = value as Filters;
      return { ...fallbackFilters, scope: stored.scope, service: stored.service || '', team: stored.team || '' };
    }
  } catch { /* Invalid browser preferences are discarded; no source data is stored here. */ }
  return fallbackFilters;
}
function format(value: number | null | undefined, unit: MetricDefinition['unit'], compact = true) {
  if (value === null || value === undefined) return '--';
  const number = new Intl.NumberFormat('en', { maximumFractionDigits: ['count', 'tokens'].includes(unit) ? 0 : 1, notation: compact && Math.abs(value) >= 10000 ? 'compact' : 'standard' }).format(value);
  const suffix: Partial<Record<MetricDefinition['unit'], string>> = { percent: '%', hours: 'h', minutes: 'm', days: 'd' };
  return suffix[unit] ? `${number}${suffix[unit]}` : number;
}
function Status({ status }: { status: string }) {
  return <span className={`status ${status}`}><span />{status === 'measured' ? 'Available' : status === 'unavailable' ? 'Needs data' : status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}
function Trend({ result, definition }: { result: MetricResult; definition: MetricDefinition }) {
  if (result.value === null || result.previous === null) return <span className="trend neutral">No comparable prior window</span>;
  const delta = result.value - result.previous;
  const Icon = delta >= 0 ? ArrowUpRight : ArrowDownRight;
  const good = definition.direction === 'lower' ? delta < 0 : definition.direction === 'higher' ? delta > 0 : null;
  return <span className={`trend ${good === null ? 'neutral' : good ? 'positive' : 'negative'}`}><Icon size={14} />{result.previous === 0 ? `${format(result.previous, definition.unit)} previously` : `${Math.abs(delta / result.previous * 100).toFixed(1)}% vs prior window`}</span>;
}
function AnalysisPanel({ dashboard, domains, title }: { dashboard: Dashboard; domains: Framework[]; title: string }) {
  const overall = domains.length > 1;
  const [aiSummary, setAiSummary] = useState('');
  const [aiError, setAiError] = useState('');
  const [generating, setGenerating] = useState(false);
  const requestId = useRef(0);
  const requestKey = JSON.stringify({ filters: dashboard.filters, domains });
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;
  useEffect(() => {
    requestId.current++;
    setAiSummary('');
    setAiError('');
    setGenerating(false);
  }, [requestKey]);
  const generate = async () => {
    const id = ++requestId.current;
    const requestedKey = requestKey;
    setGenerating(true);
    setAiError('');
    try {
      const result = await api<{ summary: string }>('analysis/copilot', 'POST', { ...dashboard.filters, domains });
      if (id === requestId.current && requestedKey === currentRequestKey.current) setAiSummary(result.summary);
    } catch (error) {
      if (id === requestId.current && requestedKey === currentRequestKey.current) {
        setAiError(error instanceof Error ? error.message : 'Copilot CLI could not generate a summary.');
      }
    } finally {
      if (id === requestId.current && requestedKey === currentRequestKey.current) setGenerating(false);
    }
  };
  const summaries = overall ? analyzeOverall(dashboard).domains : domains.map(domain => analyzeDomain(dashboard, domain));
  const available = summaries.reduce((n, summary) => n + summary.coverage.available + summary.coverage.partial, 0);
  const total = summaries.reduce((n, summary) => n + summary.coverage.total, 0);
  const serviceName = dashboard.scope.services.find(service => service.id === dashboard.filters.service)?.name;
  const teamName = dashboard.teams.find(team => team.id === dashboard.filters.team)?.name;
  const labels: Record<Framework, string> = {
    DORA: 'Software delivery', SPACE: 'Developer experience', Copilot: 'Copilot adoption',
  };
  return <section className={`panel section analysis-summary ${overall ? 'overall-analysis' : ''}`} aria-label={title}>
    <div className="analysis-summary-heading"><div><h2>{title}</h2><p>{dashboard.scope.slug}{serviceName ? ` · ${serviceName}` : ''}{teamName ? ` · ${teamName}` : ''} · {dashboard.filters.from} to {dashboard.filters.to}</p></div>{overall && <small>{available} of {total} measures have current evidence</small>}</div>
    <div className="analysis-summary-grid">{summaries.map(summary => <article className={`analysis-domain tone-${summary.tone}`} key={summary.domain}>
      <div className="analysis-domain-heading"><h3>{labels[summary.domain]}</h3><span>{summary.tone === 'limited' ? 'Limited evidence' : summary.tone === 'watch' ? 'Watch item' : summary.tone === 'positive' ? 'Favorable movement' : 'Descriptive'}</span></div>
      <ul>{summary.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>
      <p className="analysis-coverage">Evidence: {summary.coverage.available} available · {summary.coverage.partial} partial · {summary.coverage.withheld} withheld · {summary.coverage.unavailable} unavailable</p>
      {summary.sourceGaps.length > 0 && <p className="analysis-source-gaps">Source gaps: {summary.sourceGaps.slice(0, 3).map(source => `${source.source} (${source.state})`).join(', ')}{summary.sourceGaps.length > 3 ? `, +${summary.sourceGaps.length - 3} more` : ''}</p>}
    </article>)}</div>
    <p className="analysis-note">Favorable and unfavorable labels follow each measure’s catalog direction. Activity and usage changes are descriptive, not proof of productivity or causal impact.</p>
    <div className="analysis-ai-controls">
      <button className="button secondary" onClick={generate} disabled={generating} aria-describedby="analysis-ai-disclosure">
        {generating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
        {generating ? 'Generating with Copilot…' : 'Generate AI summary'}
      </button>
      <p id="analysis-ai-disclosure">On request, selected aggregate metrics and source coverage are sent to GitHub Copilot via the CLI. No individual rows, repository names, or source code are included.</p>
    </div>
    {aiError && <p className="analysis-ai-error" role="alert">{aiError}</p>}
    {aiSummary && <div className="analysis-ai-result" aria-live="polite"><h3>Copilot CLI summary</h3><p>{aiSummary}</p></div>}
  </section>;
}
function Metric({ definition, result, explain }: { definition: MetricDefinition; result: MetricResult; explain: (id: string) => void }) {
  return <button className="metric" onClick={() => explain(definition.id)} aria-label={`Explain ${definition.name}`}>
    <span className="metric-name">{definition.name}<CircleHelp size={14} /></span>
    <span className="metric-value">{format(result.value, definition.unit)}{definition.unit === 'per day' && result.value !== null && <small>/ day</small>}</span>
    {result.value === null ? <Status status={result.status} /> : <Trend result={result} definition={definition} />}
    {result.status === 'partial' && result.value !== null && <small className="partial-label">Partial coverage</small>}
  </button>;
}
function Chart({ points, unit, name, result }: { points: Point[]; unit: MetricDefinition['unit']; name: string; result?: MetricResult }) {
  const uid = useId().replaceAll(':', '');
  const group = new Map<string, number[]>();
  points.forEach(p => group.set(p.day, [...(group.get(p.day) ?? []), p.value]));
  const data = [...group].sort(([a], [b]) => a.localeCompare(b)).map(([day, values]) => ({ day, value: values.reduce((a, b) => a + b, 0) / values.length }));
  if (result?.status === 'suppressed') return <div className="chart-empty"><ShieldCheck size={24} /><strong>Values withheld for privacy</strong><span>{result.reason} Reports may be synced successfully while their values remain hidden.</span></div>;
  if (data.length < 2) return <div className="chart-empty"><Activity size={24} /><strong>A trend needs more evidence</strong><span>At least two observed days are needed. Missing days are not drawn as zeros.</span></div>;
  const w = 700, h = 210, pad = 38;
  const maximum = Math.max(...data.map(p => p.value)) * 1.15 || 1;
  const from = Date.parse(data[0]!.day), to = Date.parse(data.at(-1)!.day);
  const x = (day: string) => pad + (Date.parse(day) - from) / (to - from) * (w - pad - 12);
  const y = (value: number) => h - 20 - value / maximum * (h - 35);
  // Break lines at missing calendar days instead of connecting across unobserved gaps.
  const segments: Point[][] = [];
  for (const point of data) {
    const last = segments.at(-1)?.at(-1);
    if (!last || Date.parse(point.day) - Date.parse(last.day) > DAY) segments.push([]);
    segments.at(-1)!.push(point);
  }
  return <div className="chart">
    <svg viewBox={`0 0 ${w} ${h + 22}`} role="img" aria-labelledby={`${uid}title ${uid}desc`}>
      <title id={`${uid}title`}>{name}</title>
      <desc id={`${uid}desc`}>Observed daily values, {data[0]!.day} through {data.at(-1)!.day}. Exact values are available in the data table.</desc>
      {[0, .25, .5, .75, 1].map(tick => <g key={tick}><line className="grid-line" x1={pad} x2={w} y1={y(maximum * tick)} y2={y(maximum * tick)} /><text x={pad - 10} y={y(maximum * tick) + 4} textAnchor="end">{format(maximum * tick, unit)}</text></g>)}
      {segments.map((segment, index) => <polyline key={index} className="chart-line" points={segment.map(p => `${x(p.day)},${y(p.value)}`).join(' ')} />)}
      {data.map((p, i) => <circle key={p.day} className="chart-dot" cx={x(p.day)} cy={y(p.value)} r={i === data.length - 1 ? 4 : 2.5}><title>{p.day}: {format(p.value, unit, false)}</title></circle>)}
      {[data[0], data[Math.floor(data.length / 3)], data[Math.floor(data.length * 2 / 3)], data.at(-1)].map((p, i) => p && <text key={`${p.day}-${i}`} x={x(p.day)} y={h + 16} textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}>{new Date(p.day).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>)}
    </svg>
    <details className="chart-data"><summary>View observed daily values</summary><div className="table-scroll"><table><thead><tr><th>Date (UTC)</th><th>{name}</th></tr></thead><tbody>{data.map(p => <tr key={p.day}><td>{p.day}</td><td>{format(p.value, unit, false)}</td></tr>)}</tbody></table></div></details>
  </div>;
}
function App() {
  const [page, setPage] = useState<Page>(() => navigation.find(n => n.id === location.hash.slice(1))?.id ?? 'overview');
  const [settings, setSettings] = useState<Settings>({ scopes: [] });
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [filters, setFilters] = useState<Filters>(savedFilters);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [framework, setFramework] = useState<Framework | ''>('');
  const [dimension, setDimension] = useState('');
  const [explanation, setExplanation] = useState<string | null>(null);
  const [trendId, setTrendId] = useState('space.pr-cycle');
  const [theme, setTheme] = useState(() => localStorage.getItem('observatory.theme') ?? 'light');
  const [canvasReason, setCanvasReason] = useState('');
  const [sync, setSync] = useState({ running: false, task: '', completed: 0, failures: 0 });
  const [refresh, setRefresh] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const navigate = (next: Page) => { setPage(next); location.hash = next; setExplanation(null); };
  useEffect(() => {
    const listener = () => setPage(navigation.find(n => n.id === location.hash.slice(1))?.id ?? 'overview');
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('observatory.theme', theme);
  }, [theme]);
  useEffect(() => {
    Promise.all([session(), api<Settings>('settings')]).then(([info, stored]) => {
      setSettings(stored); setCanvasReason(info.canvas.reason);
      setFilters(current => stored.scopes.length > 1 || (current.scope !== 'demo' && !stored.scopes.some(s => s.id === current.scope)) ? fallbackFilters : current);
      setReady(true);
    }).catch(e => { setError(String(e.message)); setLoading(false); });
  }, []);
  const search = new URLSearchParams({ ...filters }).toString();
  useEffect(() => {
    if (!ready) return;
    let stale = false;
    setLoading(true); setError('');
    api<Dashboard>(`dashboard?${search}`).then(data => {
      if (stale) return;
      setDashboard(data);
      localStorage.setItem('observatory.filters', JSON.stringify(filters));
    }).catch(e => { if (!stale) { setError(e.message); setDashboard(null); } }).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [search, ready, refresh]);
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const poll = () => {
      api<typeof sync>('sync').then(value => {
        if (stopped) return;
        setSync(current => {
          if (current.running && !value.running) setRefresh(n => n + 1);
          return value;
        });
      }).catch(e => { if (!stopped) setError(e.message); });
    };
    poll();
    const interval = window.setInterval(poll, 2500);
    return () => { stopped = true; clearInterval(interval); };
  }, [ready]);
  useEffect(() => {
    if (!explanation) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setExplanation(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [explanation]);
  const result = useCallback((id: string): MetricResult => dashboard?.metrics.find(m => m.id === id) ?? { id, value: null, previous: null, status: 'unavailable', reason: 'Load a data source first.', sample: null, series: [], coverage: { from: filters.from, to: filters.to, observedDays: 0, expectedDays: 28 } }, [dashboard, filters]);
  const metric = (id: string) => <Metric key={id} definition={catalog.find(d => d.id === id)!} result={result(id)} explain={setExplanation} />;
  const definition = explanation ? catalog.find(d => d.id === explanation) : null;
  const trendDefinition = catalog.find(d => d.id === trendId)!;
  const coverageCount = dashboard?.metrics.filter(m => m.status === 'measured' || m.status === 'partial').length ?? 0;
  const suppressedCount = dashboard?.metrics.filter(m => m.status === 'suppressed').length ?? 0;
  const copilotSuppressed = dashboard?.metrics.find(m => m.id === 'copilot.dau')?.status === 'suppressed';
  const demo = filters.scope === 'demo';
  const performSync = async () => {
    try {
      const state = await api<typeof sync>('sync', 'POST', { scope: filters.scope });
      setSync(state); setNotice('Sync started. You can keep exploring while sources are collected.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Sync could not start.'); }
  };
  const save = async (value: Settings) => {
    const stored = await api<Settings>('settings', 'PUT', value);
    setSettings(stored); setNotice('Connection saved locally. Start a sync to collect evidence.');
    const added = stored.scopes.find(s => !settings.scopes.some(existing => existing.id === s.id));
    if (added) setFilters({ ...fallbackFilters, scope: added.id });
    else if (!stored.scopes.some(s => s.id === filters.scope)) setFilters(fallbackFilters);
    setRefresh(n => n + 1);
  };
  return <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
    <a className="skip-link" href="#content" onClick={event => { event.preventDefault(); document.getElementById('content')?.focus(); }}>Skip to content</a>
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('overview')} aria-label="GitHub Engineering Insights home"><span className="brand-mark"><Telescope size={23} /></span><span>GitHub<span className="brand-sub">Engineering Insights</span></span></button>
      <div className="workspace-chip"><span className="workspace-avatar">GEI</span><span>Local workspace<small>GitHub + Copilot</small></span><ChevronDown size={14} /></div>
      <nav aria-label="Main navigation">{navigation.map(({ id, name, icon: Icon }) => <button key={id} aria-label={name} title={name} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(id)} aria-current={page === id ? 'page' : undefined}><Icon size={18} /><span>{name}</span>{id === 'catalog' && <small>{catalog.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="privacy-note"><ShieldCheck size={19} /><span>Evidence, not surveillance<small>Team-level. Local-first.</small></span></div><button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle navigation labels"><PanelLeftClose size={16} /><span>Collapse sidebar</span></button><div className="version">GitHub Engineering Insights <span>v0.1</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{navigation.find(n => n.id === page)?.name}</strong></div><div className="top-actions"><button className="icon-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button><a className="docs-link" href="https://dora.dev/guides/dora-metrics/" target="_blank" rel="noreferrer">Measurement guide<ExternalLink size={13} /></a><span className="local-badge"><span />Local-first</span></div></header>
      <main id="content" tabIndex={-1}>
        <div className="page-heading"><div><h1>{titles[page][0]}</h1><p>{titles[page][1]}</p></div><div className="heading-actions"><a className="button secondary" href={`/api/export?${search}&format=csv`}><Download size={16} />Export</a><button className="button primary" onClick={demo ? () => navigate('data') : performSync} disabled={sync.running}><RefreshCw size={16} className={sync.running ? 'spin' : ''} />{demo ? 'Connect GitHub' : sync.running ? 'Syncing sources' : 'Sync data'}</button></div></div>
        {error && <div className="alert error" role="alert"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
        {notice && <div className="alert success" role="status"><Check size={18} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={16} /></button></div>}
        {demo && <div className="demo-banner"><div><span className="demo-label">DEMO</span><span>You’re exploring synthetic data. No real enterprise data is shown.</span></div><button onClick={() => navigate('data')}>{settings.scopes.length > 1 ? 'Choose one enterprise' : settings.scopes.length ? 'Manage enterprise' : 'Connect enterprise'} <ArrowRight size={14} /></button></div>}
        {sync.running && <div className="sync-banner" role="status"><LoaderCircle size={16} className="spin" /><span>{sync.task} <small>{sync.completed} sources completed, {sync.failures} gaps</small></span><button onClick={() => api('sync/cancel', 'POST').catch(e => setError(e.message))}>Cancel sync</button></div>}
        <section className="filter-bar" aria-label="Dashboard filters">
          <label className="scope-select"><GitBranch size={16} /><span className="sr-only">Data mode</span><select aria-label="Data mode" value={filters.scope} onChange={e => setFilters({ ...fallbackFilters, scope: e.target.value })}><option value="demo">Demo mode</option>{settings.scopes.length === 1 && settings.scopes.map(s => <option key={s.id} value={s.id}>Enterprise: {s.slug}</option>)}</select></label>
          <label><span className="sr-only">Service</span><select value={filters.service} onChange={e => setFilters({ ...filters, service: e.target.value, team: '' })}><option value="">All services</option>{dashboard?.scope.services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label><span className="sr-only">Team</span><select value={filters.team} onChange={e => setFilters({ ...filters, team: e.target.value, service: '' })}><option value="">Scope / all teams</option>{dashboard?.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <div className="date-filter"><label><span className="sr-only">Start date UTC</span><input type="date" aria-label="Start date UTC" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label><span>to</span><label><span className="sr-only">End date UTC</span><input type="date" aria-label="End date UTC" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label></div>
          <label><span className="sr-only">Date preset</span><select value="" onChange={e => { if (e.target.value) setFilters({ ...filters, from: dateKey(Date.now() - Number(e.target.value) * DAY), to: dateKey(Date.now() - DAY), team: '' }); }}><option value="" disabled>Choose period</option><option value="7">Last 7 days</option><option value="28">Last 28 days</option><option value="90">Last 90 days</option></select></label>
        </section>
        <div className="context-line"><span>{loading ? <><LoaderCircle size={13} className="spin" /> Loading evidence</> : <><span className="status-dot" />{coverageCount} of {catalog.length} metrics have evidence</>}</span><span>UTC dates <span className="divider-dot" /> {dashboard?.scope.allowSmallEnterpriseAggregates ? 'Enterprise aggregates: small cohorts allowed' : 'Minimum cohort: 5'} <span className="divider-dot" /> Manual sync</span></div>
        {!loading && copilotSuppressed && <div className="inline-note" role="status"><ShieldCheck size={18} /><span><strong>Reports synced, values withheld for privacy.</strong> The selected Copilot data does not meet the minimum five-person cohort requirement. “Ready” means the source was collected, not that its values can be displayed. {suppressedCount} metrics are suppressed; another sync will not override this safeguard.</span><button className="text-button" onClick={() => navigate('data')}>Review privacy setting <ArrowRight size={14} /></button></div>}
        {!loading && dashboard?.scope.allowSmallEnterpriseAggregates && <div className="inline-note" role="status"><AlertCircle size={18} /><span>Small-cohort enterprise aggregates are enabled locally. These values and exports may reveal individual activity in very small enterprises. Team and survey protections are unchanged.</span></div>}
        {loading && !dashboard ? <div className="loading-state" role="status"><LoaderCircle className="spin" size={28} /><h2>Preparing your observatory</h2><p>Loading metric definitions and local evidence.</p></div> : <>
          {page === 'overview' && dashboard && <AnalysisPanel dashboard={dashboard} domains={['DORA', 'SPACE', 'Copilot']} title="Current situation" />}
          {(page === 'overview' || page === 'dora') && <>
            {page === 'dora' && dashboard && <AnalysisPanel dashboard={dashboard} domains={['DORA']} title="DORA quick analysis" />}
            <section className="section"><div className="section-heading"><div><h2>Software delivery performance</h2><p>The five DORA metrics, measured at the service level.</p></div><span className="framework-tag">DORA</span></div>
              {!filters.service && <div className="inline-note"><GitBranch size={16} /><span>Select a service to measure DORA. Different services shouldn’t be blended into one score.</span><select aria-label="Choose DORA service" value="" onChange={e => setFilters({ ...filters, service: e.target.value, team: '' })}><option value="" disabled>Choose a service</option>{dashboard?.scope.services.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></div>}
              <div className="metric-ledger">{catalog.filter(d => d.framework === 'DORA').map(d => metric(d.id))}</div>
            </section>
            <div className="analysis-grid"><section className="panel trend-panel"><div className="panel-heading"><div><h2>Delivery over time</h2><p>Observed daily values. Gaps stay visible.</p></div><label><span className="sr-only">Chart metric</span><select value={trendId} onChange={e => setTrendId(e.target.value)}>{['space.pr-cycle', 'dora.lead', 'dora.frequency', 'space.pr-merged'].map(id => <option value={id} key={id}>{catalog.find(d => d.id === id)!.name}</option>)}</select></label></div><Chart points={result(trendId).series} unit={trendDefinition.unit} name={trendDefinition.name} /></section>
              <section className="panel reading-panel"><div className="panel-heading"><h2>Read the signals</h2><CircleHelp size={17} /></div><div className="signal"><span className="signal-icon"><GitBranch size={18} /></span><div><h3>{filters.service ? dashboard?.scope.services.find(s => s.id === filters.service)?.name : 'Keep service context'}</h3><p>{filters.service ? `Production evidence mapped to ${dashboard?.scope.services.find(s => s.id === filters.service)?.environment}. Inspect each metric’s definition before comparing.` : 'Choose one service for delivery outcomes. The portfolio view is for navigation, not a team leaderboard.'}</p></div></div><div className="signal"><span className="signal-icon green"><ShieldCheck size={18} /></span><div><h3>No data is a signal, too</h3><p>Recovery and failure rates require explicit incident coverage. A clean CI run does not prove a safe production change.</p></div></div><button className="text-button" onClick={() => navigate('data')}>Inspect source coverage <ArrowRight size={15} /></button></section></div>
          </>}
          {(page === 'overview' || page === 'space') && <section className="section"><div className="section-heading"><div><h2>A broader view of developer experience</h2><p>Five SPACE dimensions. No single productivity score.</p></div><button className="text-button" onClick={() => { if (page === 'overview') navigate('space'); else { setFramework('SPACE'); navigate('catalog'); } }}>Explore SPACE <ArrowRight size={15} /></button></div>{page === 'space' && dashboard && <AnalysisPanel dashboard={dashboard} domains={['SPACE']} title="SPACE quick analysis" />}<div className="space-grid">{([
            ['Satisfaction', 'space.satisfaction', 'How work feels', 'Survey evidence'],
            ['Performance', 'space.ci-failure', 'What work achieves', 'CI outcome context'],
            ['Activity', 'space.pr-merged', 'What happens', 'Activity, not productivity'],
            ['Collaboration', 'space.review-response', 'How people connect', 'Human review evidence'],
            ['Efficiency', 'space.pr-cycle', 'How work flows', 'PR creation to merge'],
          ] as const).map(([name, id, line, context]) => <button className="space-cell" key={name} onClick={() => { setFramework('SPACE'); setDimension(name); navigate('catalog'); }}><span className={`dimension-mark dim-${name.toLowerCase()}`}>{name.charAt(0)}</span><h3>{name}</h3><p>{line}</p><div className="space-value">{format(result(id).value, catalog.find(d => d.id === id)!.unit)}</div><small>{context}</small><span className="explore-dimension">View measures <ArrowRight size={13} /></span></button>)}</div>
            {page === 'space' && <><div className="inline-note"><Fingerprint size={17} /><span>Choose a survey team for satisfaction measures. GitHub activity cannot reveal satisfaction, sustainable workload, or focus time.</span></div><MetricTable definitions={catalog.filter(d => d.framework === 'SPACE')} result={result} explain={setExplanation} /></>}
          </section>}
          {(page === 'overview' || page === 'copilot') && <section className="section"><div className="section-heading"><div><h2>How Copilot is being used</h2><p>Adoption and engagement, separate from delivery outcomes.</p></div><span className="framework-tag copilot"><Sparkles size={14} />Copilot</span></div>{page === 'copilot' && dashboard && <AnalysisPanel dashboard={dashboard} domains={['Copilot']} title="Copilot quick analysis" />}
            {filters.service && <div className="inline-note"><CircleHelp size={17} /><span>IDE usage can’t be attributed to a service. Clear the service filter to see Copilot usage.</span><button className="text-button" onClick={() => setFilters({ ...filters, service: '' })}>Clear service</button></div>}
            <div className="metric-ledger copilot-ledger">{['copilot.dau', 'copilot.wau', 'copilot.completion-acceptance', 'copilot.interactions'].map(metric)}</div>
            <div className="analysis-grid"><section className="panel"><div className="panel-heading"><div><h2>Daily active users</h2><p>Distinct users per day, not additive across days.</p></div><span className="legend"><span />Active users</span></div><Chart points={result('copilot.dau').series} name="Daily active Copilot users" unit="count" result={result('copilot.dau')} /></section><section className="panel"><div className="panel-heading"><div><h2>Feature mix</h2><p>User interactions, not developer output.</p></div></div>{copilotSuppressed ? <div className="chart-empty"><ShieldCheck size={24} /><strong>Feature values withheld for privacy</strong><span>The selected active-user cohort does not meet the minimum of five.</span></div> : <Breakdown data={dashboard?.breakdowns.find(d => d.dimension === 'Features')?.entries ?? []} />}</section></div>
            {page === 'copilot' && <><div className="breakdown-grid">{dashboard?.breakdowns.filter(d => d.dimension !== 'Features').map(d => <section className="panel" key={d.dimension}><div className="panel-heading"><h2>{d.dimension}</h2></div><Breakdown data={d.entries} /></section>)}</div><MetricTable definitions={catalog.filter(d => d.framework === 'Copilot')} result={result} explain={setExplanation} /></>}
          </section>}
          {page === 'catalog' && <section className="section"><div className="catalog-toolbar"><label className="search-field"><Search size={17} /><span className="sr-only">Search metrics</span><input type="search" placeholder="Search definitions, sources, or metrics..." value={query} onChange={e => setQuery(e.target.value)} /></label><label><span className="sr-only">Filter framework</span><select value={framework} onChange={e => { setFramework(e.target.value as Framework | ''); setDimension(''); }}><option value="">All frameworks</option>{Object.keys(dimensions).map(f => <option key={f}>{f}</option>)}</select></label><label><span className="sr-only">Filter dimension</span><select value={dimension} onChange={e => setDimension(e.target.value)}><option value="">All dimensions</option>{(framework ? dimensions[framework] : Object.values(dimensions).flat())?.map(d => <option key={d}>{d}</option>)}</select></label></div><MetricTable definitions={catalog.filter(d => (!framework || d.framework === framework) && (!dimension || d.dimension === dimension) && `${d.name} ${d.description} ${d.source} ${d.id}`.toLowerCase().includes(query.toLowerCase()))} result={result} explain={setExplanation} /></section>}
          {page === 'data' && <DataPage settings={settings} save={save} remove={async scope => {
            const stored = await api<Settings>('enterprise', 'DELETE', { scope });
            setSettings(stored); setFilters(fallbackFilters); setDashboard(null); setExplanation(null); setRefresh(n => n + 1);
            setNotice('Enterprise and its local data removed. Demo mode is active; you can connect another enterprise.');
          }} keep={async scope => {
            const stored = await api<Settings>('enterprise/select', 'POST', { scope });
            setSettings(stored); setFilters({ ...fallbackFilters, scope }); setDashboard(null); setExplanation(null); setRefresh(n => n + 1);
            setNotice('Enterprise selected. The other connections and their local data were removed.');
          }} dashboard={dashboard} scopeId={filters.scope} refresh={() => setRefresh(n => n + 1)} onError={setError} onNotice={setNotice} canvasReason={canvasReason} />}
          <footer className="footer"><span><ShieldCheck size={14} />Built for improvement, not comparison.</span><span>Definitions grounded in DORA & SPACE <span className="divider-dot" /> Source-aware by design</span></footer>
        </>}
      </main>
    </div>
    {definition && <Explanation definition={definition} result={result(definition.id)} close={() => setExplanation(null)} />}
  </div>;
}
function MetricTable({ definitions, result, explain }: { definitions: MetricDefinition[]; result: (id: string) => MetricResult; explain: (id: string) => void }) {
  if (!definitions.length) return <div className="empty-state"><Search size={26} /><h2>No metrics match</h2><p>Try a shorter search or clear a framework/dimension filter.</p></div>;
  return <div className="table-scroll metric-table"><table><thead><tr><th>Metric</th><th>Framework / dimension</th><th>Value</th><th>Evidence</th><th>Source</th><th><span className="sr-only">Definition</span></th></tr></thead><tbody>{definitions.map(d => {
    const value = result(d.id);
    return <tr key={d.id}><td><button className="table-metric-name" onClick={() => explain(d.id)}>{d.name}</button><small>{d.kind === 'proxy' ? 'Proxy' : d.kind === 'survey' ? 'Survey aggregate' : d.grain === 'service' ? 'Service-level' : 'Direct measure'}</small></td><td><span className={`framework-label ${d.framework.toLowerCase()}`}>{d.framework}</span><small>{d.dimension}</small></td><td className="number">{format(value.value, d.unit, false)}{value.value !== null && !['hours', 'minutes', 'days', 'percent', 'count'].includes(d.unit) && <small>{d.unit}</small>}</td><td><Status status={value.status} /></td><td><span className="source-name">{d.source}</span></td><td><button className="icon-button" onClick={() => explain(d.id)} aria-label={`Explain ${d.name}`}><ArrowRight size={16} /></button></td></tr>;
  })}</tbody></table></div>;
}
function Breakdown({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((n, row) => n + row.value, 0);
  if (!data.length) return <div className="chart-empty"><Code2 size={24} /><strong>No supported breakdown yet</strong><span>Connect a report with this breakdown, or clear incompatible filters.</span></div>;
  return <div className="breakdown">{data.slice(0, 8).map((row, i) => <div key={row.name} className="breakdown-row"><div><span><span className={`color-key color-${i % 4}`} />{row.name.replaceAll('_', ' ')}</span><strong>{new Intl.NumberFormat('en').format(row.value)}</strong></div><div className="bar-track"><div className={`bar color-${i % 4}`} style={{ width: `${total ? row.value / total * 100 : 0}%` }} /></div></div>)}<small>Observed counts. Categories may cover different features.</small></div>;
}
function Explanation({ definition: d, result: r, close }: { definition: MetricDefinition; result: MetricResult; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement; closeRef.current?.focus(); return () => { if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <aside className="explanation" aria-label={`Definition: ${d.name}`}><div className="explanation-heading"><span className={`framework-label ${d.framework.toLowerCase()}`}>{d.framework} / {d.dimension}</span><button className="icon-button" onClick={close} ref={closeRef} aria-label="Close metric explanation"><X size={20} /></button></div><h2>{d.name}</h2><p>{d.description}</p><div className="explanation-value"><strong>{format(r.value, d.unit, false)}</strong><span>{d.unit}</span><Status status={r.status} /></div><dl><dt>How it is calculated</dt><dd className="formula">{d.formula}</dd><dt>Source evidence</dt><dd>{d.source}</dd><dt>Current coverage</dt><dd>{r.reason}</dd><dt>Interpret with care</dt><dd>{d.caveat}</dd><dt>Grain & type</dt><dd>{d.grain} / {d.kind}</dd><dt>Period (UTC)</dt><dd>{r.coverage.from} to {r.coverage.to}</dd>{r.sample !== null && <><dt>Sample size</dt><dd>{r.sample.toLocaleString()}</dd></>}{r.denominator !== undefined && <><dt>Numerator / denominator</dt><dd>{r.numerator} / {r.denominator}</dd></>}{r.p90 !== undefined && <><dt>90th percentile</dt><dd>{format(r.p90, d.unit)}</dd></>}<dt>Comparable previous window</dt><dd>{r.previous === null ? 'Not enough comparable coverage.' : format(r.previous, d.unit, false)}</dd></dl><small className="metric-id">{d.id}</small></aside>;
}
function DataPage({ settings, save, remove, keep, dashboard, scopeId, refresh, onError, onNotice, canvasReason }: {
  settings: Settings; save: (settings: Settings) => Promise<void>; dashboard: Dashboard | null; scopeId: string;
  remove: (scope: string) => Promise<void>;
  keep: (scope: string) => Promise<void>;
  refresh: () => void; onError: (message: string) => void; onNotice: (message: string) => void; canvasReason: string;
}) {
  const [connection, setConnection] = useState<{ state: string; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [slug, setSlug] = useState('');
  const [repos, setRepos] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [production, setProduction] = useState('production');
  const [importKind, setImportKind] = useState<'surveys' | 'incidents'>('surveys');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<{ count: number; errors: { row: number; message: string }[]; fingerprint: string; suppressedRows: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [privacyApproval, setPrivacyApproval] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [enterpriseToKeep, setEnterpriseToKeep] = useState('');
  useEffect(() => setPrivacyApproval(false), [scopeId]);
  const selectedEnterprise = settings.scopes[0];
  const [mappingRepo, setMappingRepo] = useState('');
  const [mapName, setMapName] = useState('');
  const [mapEnvironment, setMapEnvironment] = useState('production');
  const check = async () => {
    setBusy(true);
    try { setConnection(await api('connection')); } catch (e) { onError(e instanceof Error ? e.message : 'Could not check connection.'); } finally { setBusy(false); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true);
    try {
      const repositories = repos.split(/[\s,]+/).filter(Boolean);
      const scope: Scope = { id: `ent-${slug}`, kind: 'enterprise', slug, repositories, services: [] };
      if (serviceName) {
        if (!repositories[0]) throw new Error('Add a repository before mapping a production service.');
        scope.services.push({ id: serviceId || slug, name: serviceName, repository: repositories[0], environment: production });
      }
      if (settings.scopes.length) throw new Error('Remove the current enterprise before connecting another.');
      await save({ scopes: [scope] });
      setSlug(''); setRepos(''); setServiceName(''); setServiceId('');
    } catch (e) { onError(e instanceof Error ? e.message : 'Connection was not saved.'); } finally { setSaving(false); }
  };
  const importCsv = async (commit: boolean) => {
    setBusy(true);
    try {
      const value = await api<typeof preview & { committed: boolean }>('import', 'POST', { scope: scopeId, kind: importKind, csv, commit, fingerprint: preview?.fingerprint });
      setPreview(value);
      if (commit) { onNotice('Validated import saved atomically. Metrics have been refreshed.'); refresh(); setPreview(null); setCsv(''); setFileName(''); }
    } catch (e) { onError(e instanceof Error ? e.message : 'Import failed.'); } finally { setBusy(false); }
  };
  if (settings.scopes.length > 1) return <section className="panel section"><div className="panel-heading"><div><h2>Choose one enterprise</h2><p>There are {settings.scopes.length} connections from the previous version. Demo mode remains available while you choose.</p></div></div><p>Keep one enterprise below. Confirming permanently removes the other connections and their local reports, imports and checkpoints. Nothing changes on GitHub or in your CLI credentials.</p><label className="privacy-consent">Enterprise to keep<select value={enterpriseToKeep} onChange={e => setEnterpriseToKeep(e.target.value)}><option value="">Choose enterprise</option>{settings.scopes.filter(s => s.kind === 'enterprise').map(s => <option key={s.id} value={s.id}>{s.slug}</option>)}</select></label><button className="button danger" disabled={busy || !enterpriseToKeep} onClick={async () => {
    setBusy(true);
    try { await keep(enterpriseToKeep); setEnterpriseToKeep(''); } catch (e) { onError(e instanceof Error ? e.message : 'Enterprise selection could not be saved.'); } finally { setBusy(false); }
  }}>Keep selected enterprise and remove the others</button><p className="help-text">No existing connection or data is removed until you confirm this choice.</p></section>;
  return <>
    <div className="data-grid"><section className="panel"><div className="panel-heading"><div><h2><Cable size={19} />GitHub connection</h2><p>Existing CLI authentication. No token pasted into the browser.</p></div></div><div className="connection-check"><span className={`connection-indicator ${connection?.state === 'ready' ? 'connected' : ''}`}><GitBranch size={22} /></span><div><strong>{connection?.state === 'ready' ? 'GitHub CLI connected' : 'Check your local GitHub session'}</strong><p>{connection?.message ?? 'The server uses gh on github.com. Each source is checked independently during sync.'}</p></div></div><button className="button secondary" onClick={check} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}Check connection</button><p className="help-text">If needed, sign in from your terminal with <code>gh auth login --hostname github.com</code>. This app never changes scopes or enterprise policies.</p></section>
      <section className="panel"><div className="panel-heading"><h2><ShieldCheck size={19} />Privacy by construction</h2></div><ul className="check-list"><li><Check size={15} />Local SQLite storage; loopback-only server</li><li><Check size={15} />No source code, prompts, or survey identities</li><li><Check size={15} />People-based cohorts below five withheld</li><li><Check size={15} />No individual rankings or inferred ROI</li></ul><p className="help-text">Initial windows: 90 days of GitHub metadata and 28 days of Copilot reports. Permissions and telemetry delays may reduce coverage.</p></section></div>
    {selectedEnterprise && <section className="panel section"><div className="panel-heading"><div><h2>Small-enterprise privacy setting</h2><p>Applies only to {selectedEnterprise.slug}, on this machine. No sync is required after saving.</p></div></div><p className="help-text">The default minimum of five hides this enterprise’s Copilot data. Enabling small-cohort aggregates can reveal an individual’s activity when the enterprise is very small, including in charts, breakdowns and exports. No individual user rows or rankings are exposed. Team, survey and reviewer protections stay at five.</p>{!selectedEnterprise.allowSmallEnterpriseAggregates && <label className="privacy-consent"><input type="checkbox" checked={privacyApproval} onChange={e => setPrivacyApproval(e.target.checked)} />I understand the disclosure risk and approve showing small-cohort Copilot aggregates for this enterprise locally.</label>}<button className="button secondary" disabled={busy || (!selectedEnterprise.allowSmallEnterpriseAggregates && !privacyApproval)} onClick={async () => {
      setBusy(true);
      try {
        const enabled = !selectedEnterprise.allowSmallEnterpriseAggregates;
        await save({ scopes: settings.scopes.map(s => s.id === selectedEnterprise.id ? { ...s, allowSmallEnterpriseAggregates: enabled } : s) });
        setPrivacyApproval(false);
        onNotice(enabled ? 'Small-cohort enterprise aggregates enabled locally. Existing data is recalculated immediately; no sync needed.' : 'Five-person enterprise privacy protection restored.');
      } catch (e) { onError(e instanceof Error ? e.message : 'Privacy setting could not be saved.'); } finally { setBusy(false); }
    }}>{selectedEnterprise.allowSmallEnterpriseAggregates ? 'Restore five-person protection' : 'Allow small-cohort enterprise aggregates'}</button></section>}
    {!selectedEnterprise && <section className="panel section"><div className="panel-heading"><div><h2>Connect an enterprise</h2><p>Use Demo mode or connect one GitHub Enterprise Cloud account. You can remove it and connect another later.</p></div></div><form onSubmit={submit} className="connection-form"><label>Enterprise slug<input required value={slug} onChange={e => setSlug(e.target.value)} placeholder="your-enterprise" pattern="[a-zA-Z0-9][a-zA-Z0-9-]*" /></label><label className="wide">Repositories <small>Optional for Copilot usage. owner/repository, separated by spaces or commas; up to 20</small><input value={repos} onChange={e => setRepos(e.target.value)} placeholder="your-organization/api, your-organization/web" /></label><details className="wide advanced-mapping"><summary>Optional production service for DORA</summary><div className="connection-form"><label>First production service <small>Maps to the first repository</small><input value={serviceName} onChange={e => setServiceName(e.target.value)} placeholder="Checkout API" /></label><label>Stable service ID<input value={serviceId} onChange={e => setServiceId(e.target.value)} placeholder={slug || 'checkout'} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" /></label><label>Production environment<input value={production} onChange={e => setProduction(e.target.value)} required={Boolean(serviceName)} /></label></div></details><div className="form-action"><button className="button primary" disabled={saving}>{saving ? 'Connecting...' : 'Connect enterprise'}<ArrowRight size={15} /></button></div></form></section>}
    {selectedEnterprise && <section className="panel section"><div className="panel-heading"><div><h2>Connected enterprise</h2><p>Only one enterprise is stored at a time. Removing it does not change anything on GitHub.</p></div><button className="button secondary" disabled={busy} onClick={() => setConfirmRemoval(true)}>Remove enterprise</button></div>{confirmRemoval && <div className="import-preview" role="group" aria-label="Confirm enterprise removal"><strong>Remove {selectedEnterprise.slug} and its local data?</strong><p>This deletes the connection, downloaded reports, imported evidence and sync checkpoints from this app. GitHub data and saved CLI credentials are not changed. Demo mode remains available.</p><div className="heading-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmRemoval(false)}>Keep enterprise</button><button className="button danger" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await remove(selectedEnterprise.id); setConfirmRemoval(false); setPreview(null); setCsv(''); setFileName(''); setPrivacyApproval(false); setMappingRepo(''); } catch (e) { onError(e instanceof Error ? e.message : 'Enterprise could not be removed.'); } finally { setBusy(false); }
    }}>Remove enterprise and local data</button></div></div>}{settings.scopes.map(s => <div className="scope-detail" key={s.id}><h3>{s.slug}<span className="framework-tag">Enterprise</span></h3><p>{s.repositories.join(', ') || 'Copilot reports only. No repositories configured.'}</p>{s.services.map(service => <div className="mapping-row" key={service.id}><GitBranch size={15} /><strong>{service.name}</strong><span>{service.repository}</span><code>{service.environment}</code></div>)}</div>)}{selectedEnterprise.repositories.length > 0 && <details className="advanced-mapping"><summary>Production service mappings for DORA</summary><form className="mapping-form" onSubmit={async e => {
      e.preventDefault();
      try {
        const scope = selectedEnterprise;
        if (!mappingRepo) throw new Error('Choose an enterprise repository.');
        const mapping: Scope['services'][number] = { id: mapName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name: mapName, repository: mappingRepo, environment: mapEnvironment };
        await save({ scopes: settings.scopes.map(s => s.id === scope.id ? { ...s, services: [...s.services, mapping] } : s) }); setMapName('');
      } catch (e) { onError(e instanceof Error ? e.message : 'Mapping failed.'); }
    }}><label>Repository<select required value={mappingRepo} onChange={e => setMappingRepo(e.target.value)}><option value="">Choose repository</option>{selectedEnterprise.repositories.map(r => <option key={r}>{r}</option>)}</select></label><label>Service name<input required value={mapName} onChange={e => setMapName(e.target.value)} /></label><label>Environment<input required value={mapEnvironment} onChange={e => setMapEnvironment(e.target.value)} /></label><button className="button secondary">Add mapping</button></form></details>}</section>}
    <section className="panel section"><div className="panel-heading"><div><h2><Upload size={19} />Import missing evidence</h2><p>Incident/deployment links and anonymous survey aggregates. Preview before saving.</p></div><a className="button secondary" href={`/api/templates/${importKind}`}><Download size={15} />CSV template</a></div><div className="import-controls"><label>Evidence type<select value={importKind} onChange={e => { setImportKind(e.target.value as typeof importKind); setPreview(null); setCsv(''); setFileName(''); }}><option value="surveys">Survey aggregates</option><option value="incidents">Incidents & observation coverage</option></select></label><label className="file-picker"><Upload size={18} /><span>{fileName || 'Choose a CSV file'}</span><input type="file" accept=".csv,text/csv" disabled={scopeId === 'demo'} onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 2 * 1024 * 1024) { onError('CSV must be smaller than 2 MB.'); return; }
      setFileName(file.name); setCsv(await file.text()); setPreview(null);
    }} /></label><button className="button secondary" disabled={!csv || busy || scopeId === 'demo'} onClick={() => importCsv(false)}>Preview import</button></div>{scopeId === 'demo' && <p className="help-text">Demo data is read-only. Select a configured live scope to import evidence.</p>}{importKind === 'incidents' && <p className="help-text">Use a <code>coverage</code> row to attest incident observation for a service and period, including periods with zero incidents. Deployment links use exact IDs from <a href={`/api/deployments?scope=${encodeURIComponent(scopeId)}`} target="_blank" rel="noreferrer">production evidence</a>. Separate multiple links with semicolons.</p>}{preview && <div className="import-preview"><strong>{preview.count} valid rows; {preview.errors.length} errors</strong><p>{preview.suppressedRows} small-cohort rows will be withheld from metric displays.</p>{preview.errors.length > 0 && <ul>{preview.errors.slice(0, 20).map((e, i) => <li key={i}>Row {e.row}: {e.message}</li>)}</ul>}<button className="button primary" disabled={busy || preview.errors.length > 0 || !preview.count} onClick={() => importCsv(true)}>Import {preview.count} validated rows</button></div>}</section>
    <section className="panel section"><div className="panel-heading"><div><h2>Source coverage</h2><p>Unavailable data is not zero. Source-specific access is checked during sync.</p></div><button className="icon-button" onClick={refresh} aria-label="Refresh coverage"><RefreshCw size={17} /></button></div><div className="table-scroll"><table><thead><tr><th>Source</th><th>State</th><th>Observed window</th><th>Details</th></tr></thead><tbody>{dashboard?.sources.map(s => <tr key={s.source}><td><code>{s.source}</code></td><td><Status status={s.state} /></td><td>{s.from && s.to ? `${s.from} - ${s.to}` : 'Not established'}</td><td>{s.message}</td></tr>)}</tbody></table></div>{!dashboard?.sources.length && <div className="empty-state"><Database size={26} /><h3>No sources synced yet</h3><p>Save a connection, select it, then use Sync data.</p></div>}</section>
    <section className="canvas-note"><div className="signal-icon"><LayoutDashboard size={20} /></div><div><h3>Companion Copilot canvas</h3><p>{canvasReason}</p><p>Use this web app directly while canvas discovery tooling is unavailable. No registered canvas is claimed.</p></div></section>
  </>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
