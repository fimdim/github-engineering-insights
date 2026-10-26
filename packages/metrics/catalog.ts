import type { Dimension, MetricDefinition } from './types.js';

const definition = (
  id: string, name: string, dimension: Dimension, unit: MetricDefinition['unit'],
  description: string, formula: string, source: string,
  extra: Partial<MetricDefinition> = {},
): MetricDefinition => ({
  id, name, dimension, unit, description, formula, source,
  framework: id.startsWith('dora.') ? 'DORA' : id.startsWith('space.') ? 'SPACE' : 'Copilot',
  caveat: 'Interpret within the same service or cohort over time, not as an individual productivity measure.',
  direction: 'context', kind: 'direct', grain: 'scope', ...extra,
});

export const catalog: MetricDefinition[] = [
  definition('dora.frequency', 'Deployment frequency', 'Throughput', 'per day', 'Successful production deliveries for one configured service.', 'Distinct successful production deployment IDs / calendar days in window', 'GitHub deployments + statuses', { grain: 'service', direction: 'context', caveat: 'Only the mapped production environment counts. CI runs and releases are not deployments.' }),
  definition('dora.lead', 'Change lead time', 'Throughput', 'hours', 'Commit-to-first-successful-production-deployment duration.', 'Median (first production deployment timestamp - committed timestamp), per newly deployed commit', 'Deployment SHA ancestry + commit metadata', { grain: 'service', direction: 'lower', caveat: 'First baseline deployment is excluded. Squashed changes use the actual deployed commit; unresolvable ancestry is a gap, not PR cycle time.' }),
  definition('dora.recovery', 'Failed deployment recovery time', 'Throughput', 'hours', 'Time to restore service after a deployment-caused failure.', 'Median (recovered_at - failed_at) for explicitly deployment-linked incidents', 'Incident CSV + production deployment IDs', { grain: 'service', direction: 'lower', caveat: 'Unresolved incidents are excluded from the duration and flagged. General incident MTTR is not this metric.' }),
  definition('dora.failure', 'Change fail rate', 'Instability', 'percent', 'Share of production deployments requiring immediate intervention.', '100 x distinct failed production deployments / eligible production deployments', 'Incident CSV + production deployments', { grain: 'service', direction: 'lower', caveat: 'Requires incident observation coverage. A pipeline failure does not prove a production change failure.' }),
  definition('dora.rework', 'Deployment rework rate', 'Instability', 'percent', 'Share of production deployments that are unplanned responses to incidents.', '100 x distinct incident-driven rework deployment IDs / eligible production deployments', 'Incident CSV + explicit rework links', { grain: 'service', direction: 'lower' }),
  ...([
    ['satisfaction', 'Developer satisfaction'], ['friction', 'Perceived development friction'],
    ['sustainability', 'Sustainable workload'], ['copilot-usefulness', 'Perceived Copilot usefulness'],
  ] as const).map(([id, name]) => definition(`space.${id}`, name, 'Satisfaction', 'score', 'Anonymous team-level survey aggregate on its declared scale.', 'Response-count-weighted mean of comparable non-overlapping survey aggregates', 'Survey CSV', { kind: 'survey', grain: 'team', caveat: 'Minimum five responses. Compare like questions and scales; not inferred from activity. No identities or free text.' })),
  definition('space.response-rate', 'Survey response rate', 'Satisfaction', 'percent', 'Participation in a single known survey cohort.', '100 x response count / eligible population', 'Survey CSV', { grain: 'team', kind: 'survey' }),
  definition('space.incidents', 'Deployment-linked incidents', 'Performance', 'count', 'Incidents explicitly linked to production changes.', 'Count distinct linked incident IDs with failure in window', 'Incident CSV', { grain: 'service', direction: 'lower' }),
  definition('space.quality', 'Imported quality outcome', 'Performance', 'score', 'A team-supplied numerical quality outcome, with its declared scale.', 'Response-weighted mean of quality-outcome aggregates', 'Survey CSV', { grain: 'team', kind: 'survey', caveat: 'A supplied outcome, not an inference from PR or commit volume. Definition and scale must remain consistent.' }),
  definition('space.pr-opened', 'Pull requests opened', 'Activity', 'count', 'Repository PRs created in the window.', 'Count distinct PR IDs by created_at', 'GitHub pull requests', { grain: 'repository' }),
  definition('space.pr-merged', 'Pull requests merged', 'Activity', 'count', 'Repository PRs merged in the window.', 'Count distinct PR IDs by merged_at', 'GitHub pull requests', { grain: 'repository' }),
  definition('space.pr-reviewed', 'Pull requests reviewed', 'Activity', 'count', 'PRs receiving a submitted human review in the window.', 'Count distinct PR IDs with a non-pending human review', 'GitHub reviews', { grain: 'repository' }),
  definition('space.issues-opened', 'Issues opened', 'Activity', 'count', 'Repository issues created, excluding pull requests.', 'Count distinct issue IDs by created_at', 'GitHub issues', { grain: 'repository' }),
  definition('space.issues-closed', 'Issues closed', 'Activity', 'count', 'Repository issues closed in the window.', 'Count distinct issue IDs by closed_at', 'GitHub issues', { grain: 'repository' }),
  definition('space.commits', 'Commits', 'Activity', 'count', 'Default-branch commits observed by the repository API.', 'Count distinct commit SHAs by committed timestamp', 'GitHub commits', { grain: 'repository', caveat: 'Default branch only. Squash and merge strategies affect counts; not productivity.' }),
  definition('space.runs', 'Workflow runs', 'Activity', 'count', 'Distinct CI workflow runs, not retry attempts.', 'Count distinct workflow run IDs', 'GitHub Actions', { grain: 'repository' }),
  definition('space.review-response', 'First human review response', 'Collaboration', 'hours', 'Time from PR creation to first submitted non-author human review.', 'Median (first human review submitted_at - PR created_at)', 'GitHub PRs + reviews', { grain: 'repository', direction: 'lower', caveat: 'Uses PR creation, including draft time; ready-to-review timestamps are not currently collected.' }),
  definition('space.review-coverage', 'Human review coverage', 'Collaboration', 'percent', 'Merged PRs with at least one non-author human review before merge.', '100 x reviewed merged PRs / merged PRs', 'GitHub PRs + reviews', { grain: 'repository', kind: 'proxy' }),
  definition('space.reviewers', 'Distinct human reviewers', 'Collaboration', 'count', 'Unique non-author human reviewers in the window.', 'Distinct reviewer IDs; suppress below five', 'GitHub reviews', { grain: 'scope' }),
  definition('space.review-iterations', 'Review iterations', 'Collaboration', 'count', 'Submitted human reviews per reviewed PR.', 'Mean submitted non-author human review count per reviewed PR', 'GitHub reviews', { grain: 'repository', kind: 'proxy', caveat: 'Review submissions are a proxy for iteration; not every submission is a change cycle.' }),
  definition('space.cross-team', 'Cross-team review participation', 'Collaboration', 'percent', 'Reviews crossing dated author/reviewer team boundaries.', 'Cross-team review count / eligible human reviews', 'Dated GitHub membership + reviews', { grain: 'team', kind: 'proxy', caveat: 'Unavailable until dated membership covers repository review participants. Current team membership cannot reconstruct history.' }),
  definition('space.pr-cycle', 'PR cycle time', 'Efficiency', 'hours', 'PR creation-to-merge time, distinct from DORA lead time.', 'Median (merged_at - created_at) for PRs merged in window', 'GitHub pull requests', { grain: 'repository', direction: 'lower' }),
  definition('space.pr-ready', 'Ready-to-review to merge', 'Efficiency', 'hours', 'Duration after leaving draft until merge.', 'Median (merged_at - ready_for_review event)', 'GitHub PR timeline', { grain: 'repository', direction: 'lower', caveat: 'Unavailable until timeline ingestion is enabled; creation time is not substituted.' }),
  definition('space.pr-age', 'Open PR age', 'Efficiency', 'days', 'Age of PRs open at the end of the selected window.', 'Median (window end - created_at) for open PRs', 'GitHub pull requests', { grain: 'repository', direction: 'lower' }),
  definition('space.wip', 'Open pull requests', 'Efficiency', 'count', 'Work in progress at the end of the selected window.', 'Count PRs created by window end and not closed by then', 'GitHub pull requests', { grain: 'repository' }),
  definition('space.issue-resolution', 'Issue resolution time', 'Efficiency', 'hours', 'Creation-to-close time for issues closed in the window.', 'Median (closed_at - created_at)', 'GitHub issues', { grain: 'repository', direction: 'lower' }),
  definition('space.ci-queue', 'CI queue time', 'Efficiency', 'minutes', 'Wait between workflow creation and start.', 'Median (run_started_at - created_at)', 'GitHub Actions', { grain: 'repository', direction: 'lower' }),
  definition('space.ci-duration', 'CI run duration', 'Efficiency', 'minutes', 'Execution duration of a workflow attempt.', 'Median (last job completed_at - run_started_at)', 'GitHub Actions jobs', { grain: 'repository', direction: 'lower', caveat: 'Unavailable without job completion evidence; run updated_at is not a reliable finish time.' }),
  definition('space.ci-failure', 'CI failure rate', 'Performance', 'percent', 'Completed runs whose latest observed conclusion is failure.', '100 x failed completed runs / completed runs', 'GitHub Actions', { grain: 'repository', direction: 'lower', caveat: 'CI outcome context, not production change fail rate. Latest attempt may mask earlier failures.' }),
  definition('space.ci-retry', 'Workflow retry rate', 'Efficiency', 'percent', 'Runs with more than one execution attempt.', '100 x run_attempt > 1 / observed runs', 'GitHub Actions', { grain: 'repository', direction: 'lower' }),
  definition('copilot.seats', 'Assigned Copilot seats', 'Adoption', 'count', 'Current assigned-seat snapshot.', 'Latest total_seats returned by seat API', 'Copilot billing seats', { field: 'seats', aggregation: 'latest', caveat: 'Current snapshot only; not a historical licensed population.' }),
  definition('copilot.seat-active', 'Active seat share', 'Adoption', 'percent', 'Seat engagement for a matching historical population.', 'Active seated users / seats for the same period and scope', 'Dated seat snapshots + usage', { caveat: 'Unavailable until dated seat membership covers the selected period. Current seats are not used as a historical denominator.' }),
  definition('copilot.inactive-seats', 'Inactive seats', 'Adoption', 'count', 'Assigned seats with no activity in a comparable window.', 'Assigned users minus active users for matching seat/window evidence', 'Dated seat snapshots + usage'),
  definition('copilot.completion-acceptance', 'Completion acceptance rate', 'Usage', 'percent', 'Acceptance within code_completion only.', '100 x completion acceptances / completion generations', 'Copilot totals_by_feature', { caveat: 'Only completion events are compared. Chat copies, agent edits, and all-feature generation counts are not mixed.' }),
  definition('copilot.repeat', 'Repeat engagement', 'Adoption', 'percent', 'Users active on at least two distinct days in the selected window.', '100 x users active on 2+ days / distinct active users', 'Daily per-user usage', { caveat: 'Minimum five active users. Requires complete daily user-report coverage.' }),
];

const fields: [string, string, Dimension, MetricDefinition['unit'], string, 'sum' | 'latest' | 'median' | 'mean'][] = [
  ['dau', 'Daily active users', 'Adoption', 'count', 'daily_active_users', 'latest'],
  ['wau', 'Weekly active users', 'Adoption', 'count', 'weekly_active_users', 'latest'],
  ['mau', 'Monthly active users', 'Adoption', 'count', 'monthly_active_users', 'latest'],
  ['agent-users', 'Monthly active agent users', 'Adoption', 'count', 'monthly_active_agent_users', 'latest'],
  ['chat-users', 'Monthly active chat users', 'Adoption', 'count', 'monthly_active_chat_users', 'latest'],
  ['cloud-users', 'Daily cloud agent users', 'Adoption', 'count', 'daily_active_copilot_cloud_agent_users', 'latest'],
  ['review-users', 'Daily code review users', 'Adoption', 'count', 'daily_active_copilot_code_review_users', 'latest'],
  ['passive-review-users', 'Passive code review users', 'Adoption', 'count', 'daily_passive_copilot_code_review_users', 'latest'],
  ['cli-users', 'Daily CLI users', 'Adoption', 'count', 'daily_active_cli_users', 'latest'],
  ['app-users', 'Daily Copilot App users', 'Adoption', 'count', 'daily_active_copilot_app_users', 'latest'],
  ['vscode-users', 'Daily VS Code agent users', 'Adoption', 'count', 'daily_active_vscode_agent_users', 'latest'],
  ['interactions', 'User-initiated interactions', 'Usage', 'count', 'user_initiated_interaction_count', 'sum'],
  ['generations', 'Code generation events', 'Code generation', 'count', 'code_generation_activity_count', 'sum'],
  ['acceptances', 'Code acceptance actions', 'Code generation', 'count', 'code_acceptance_activity_count', 'sum'],
  ['loc-suggested', 'Lines suggested to add', 'Code generation', 'count', 'loc_suggested_to_add_sum', 'sum'],
  ['loc-added', 'Lines added in the editor', 'Code generation', 'count', 'loc_added_sum', 'sum'],
  ['loc-deleted', 'Lines deleted in the editor', 'Code generation', 'count', 'loc_deleted_sum', 'sum'],
  ['cli-sessions', 'CLI sessions', 'Agent activity', 'count', 'totals_by_cli.session_count', 'sum'],
  ['cli-prompts', 'CLI prompts', 'Agent activity', 'count', 'totals_by_cli.prompt_count', 'sum'],
  ['cli-requests', 'CLI model requests', 'Agent activity', 'count', 'totals_by_cli.request_count', 'sum'],
  ['cli-input', 'CLI prompt tokens', 'Agent activity', 'tokens', 'totals_by_cli.token_usage.prompt_tokens_sum', 'sum'],
  ['cli-output', 'CLI output tokens', 'Agent activity', 'tokens', 'totals_by_cli.token_usage.output_tokens_sum', 'sum'],
  ['app-sessions', 'Copilot App sessions', 'Agent activity', 'count', 'totals_by_copilot_app.session_count', 'sum'],
  ['app-prompts', 'Copilot App prompts', 'Agent activity', 'count', 'totals_by_copilot_app.prompt_count', 'sum'],
  ['app-requests', 'Copilot App model requests', 'Agent activity', 'count', 'totals_by_copilot_app.request_count', 'sum'],
  ['app-input', 'Copilot App prompt tokens', 'Agent activity', 'tokens', 'totals_by_copilot_app.token_usage.prompt_tokens_sum', 'sum'],
  ['app-output', 'Copilot App output tokens', 'Agent activity', 'tokens', 'totals_by_copilot_app.token_usage.output_tokens_sum', 'sum'],
  ['vscode-sessions', 'VS Code agent sessions', 'Agent activity', 'count', 'totals_by_vscode_agent.session_count', 'sum'],
  ['vscode-messages', 'VS Code agent messages', 'Agent activity', 'count', 'totals_by_vscode_agent.total_user_messages', 'sum'],
  ['pr-created', 'PRs created', 'Agent activity', 'count', 'pull_requests.total_created', 'sum'],
  ['pr-merged', 'PRs merged', 'Agent activity', 'count', 'pull_requests.total_merged', 'sum'],
  ['pr-cloud', 'Cloud agent PRs created', 'Agent activity', 'count', 'pull_requests.total_created_by_copilot', 'sum'],
  ['pr-cloud-merged', 'Cloud agent PRs merged', 'Agent activity', 'count', 'pull_requests.total_merged_created_by_copilot', 'sum'],
  ['pr-reviewed', 'Copilot-reviewed PRs', 'Agent activity', 'count', 'pull_requests.total_reviewed_by_copilot', 'sum'],
  ['pr-reviewed-merged', 'Copilot-reviewed PRs merged', 'Agent activity', 'count', 'pull_requests.total_merged_reviewed_by_copilot', 'sum'],
  ['suggestions', 'Copilot review suggestions', 'Agent activity', 'count', 'pull_requests.total_copilot_suggestions', 'sum'],
  ['applied-suggestions', 'Copilot review suggestions applied', 'Agent activity', 'count', 'pull_requests.total_copilot_applied_suggestions', 'sum'],
  ['cloud-merge-time', 'Cloud agent PR merge time', 'Agent activity', 'minutes', 'pull_requests.median_minutes_to_merge_copilot_authored', 'median'],
  ['review-merge-time', 'Copilot-reviewed PR merge time', 'Agent activity', 'minutes', 'pull_requests.median_minutes_to_merge_copilot_reviewed', 'median'],
];

catalog.push(...fields.map(([id, name, dimension, unit, field, aggregation]) => definition(
  `copilot.${id}`, name, dimension, unit, `Source-provided ${name.toLowerCase()} at its reported scope.`,
  aggregation === 'latest' ? `Latest reported ${field} in window (not sum of unique counts)` :
    aggregation === 'median' ? `Latest daily ${field}; daily medians are not combined` : `Sum non-overlapping daily ${field}`,
  'Copilot usage reports', {
    field, aggregation,
    caveat: id.startsWith('loc') ? 'Editor telemetry only; not production code shipped, quality, or productivity.' :
      aggregation === 'median' ? 'Shows latest reported daily median. An overall median cannot be reconstructed from daily medians.' :
      'Availability varies by scope, feature, policy, and report version. Missing fields are not zero.',
  },
)));
catalog.push(definition('copilot.credits', 'AI credits consumed', 'Usage', 'credits', 'Consumption from per-user usage reports, aggregated without exposing users.', 'Sum daily ai_credits_used across unique users', 'Copilot daily user reports', { field: 'ai_credits_used', aggregation: 'sum', caveat: 'Consumption analysis, not invoiced cost. Requires complete daily-user coverage and a cohort of at least five.' }));
catalog.push(
  definition('copilot.agent-adoption', 'Agent adoption share', 'Adoption', 'percent', 'Share of monthly active Copilot users using IDE agents.', '100 x monthly_active_agent_users / monthly_active_users, from the same latest daily report', 'Copilot monthly active-user counters', { caveat: 'Calendar-month counters, not a rolling 28-day adoption rate. CLI, App, and cloud surfaces have separate counters.' }),
  definition('copilot.chat-average', 'Chat interactions per active user', 'Usage', 'count', 'Average chat interactions per observed active chat-user population.', 'Chat interactions / active chat users for matching period', 'Copilot chat usage', { caveat: 'Unavailable unless a report provides matching interaction and unique chat-user windows. Daily active users cannot be summed into a period denominator.' }),
  definition('copilot.agent-contribution', 'Agent contribution to editor changes', 'Code generation', 'percent', 'Agent/edit-mode share of supported editor lines added and deleted.', '100 x agent/edit feature (lines added + deleted) / total supported editor lines changed', 'Copilot totals_by_feature', { caveat: 'Requires complete feature counters. Editor changes are not committed or shipped lines; a copy/accept action is not proof of use.' }),
  definition('copilot.cli-tokens-average', 'CLI tokens per request', 'Agent activity', 'tokens', 'Weighted token use per CLI model request.', 'Sum (prompt tokens + output tokens) / sum CLI requests', 'Copilot totals_by_cli', { caveat: 'Computed from additive counts, never an unweighted mean of daily averages. Not invoiced cost.' }),
  definition('copilot.app-tokens-average', 'App tokens per request', 'Agent activity', 'tokens', 'Weighted token use per Copilot App model request.', 'Sum (prompt tokens + output tokens) / sum App requests', 'Copilot totals_by_copilot_app'),
  definition('copilot.review-acceptance', 'Code review suggestion application', 'Agent activity', 'percent', 'Application of source-attributed Copilot code review suggestions.', '100 x Copilot applied suggestions / Copilot suggestions', 'Copilot pull_requests counters', { caveat: 'Reported application signals, not independent code quality or defect reduction.' }),
);
for (const phase of ['No Cohort', 'Phase 1', 'Phase 2', 'Phase 3']) {
  catalog.push(definition(`copilot.cohort-${phase === 'No Cohort' ? 'passive' : phase.at(-1)}`, `${phase === 'No Cohort' ? 'Passive' : phase} adoption cohort`, 'Adoption', 'count', 'Latest source-classified adoption cohort population.', 'Latest totals_by_ai_adoption_phase.users_in_phase_28d for this phase', 'Copilot source adoption cohorts', { caveat: 'Source-defined phases, not custom classifications. All cohort bins must meet the minimum of five; comparisons are associations, not causal impact.' }));
}
for (const [feature, name] of [
  ['code_completion', 'Completion'], ['agent_edit', 'Agent/edit'], ['code_review_active', 'Active code review'],
  ['code_review_passive', 'Passive code review'], ['cloud_agent', 'Cloud agent'], ['copilot_cli', 'CLI'], ['github_app', 'Copilot App'],
]) {
  catalog.push(definition(`copilot.engagement-${feature}`, `${name} feature engagement`, 'Adoption', 'count', 'Users who engaged with this feature on at least two distinct days in a source-reported 28-day window.', 'copilot_feature_engagement.totals_by_feature.engaged_user_count for exact matching report window', 'Copilot 28-day aggregate report', { caveat: 'Requires the exact source 28-day window and a cohort of five or more in every displayed feature bin. Feature populations overlap and are not additive.' }));
}

export const dimensions: Record<string, string[]> = {
  DORA: ['Throughput', 'Instability'],
  SPACE: ['Satisfaction', 'Performance', 'Activity', 'Collaboration', 'Efficiency'],
  Copilot: ['Adoption', 'Usage', 'Code generation', 'Agent activity'],
};
export const metricById = (id: string) => catalog.find(metric => metric.id === id);
