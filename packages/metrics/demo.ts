import { dateKey, DAY } from './types.js';
import type { Dataset, Fact, Scope } from './types.js';

export const demoScope: Scope = {
  id: 'demo', kind: 'organization', slug: 'northstar-labs',
  repositories: ['northstar/checkout', 'northstar/platform', 'northstar/storefront'],
  services: [
    { id: 'checkout', name: 'Checkout API', repository: 'northstar/checkout', environment: 'production' },
    { id: 'platform', name: 'Developer platform', repository: 'northstar/platform', environment: 'production' },
    { id: 'storefront', name: 'Storefront', repository: 'northstar/storefront', environment: 'production' },
  ],
};
export function demoDataset(now = Date.now()): Dataset {
  const today = Date.parse(dateKey(now)), facts: Fact[] = [];
  const put = (source: string, id: string, at: string, data: Record<string, unknown>) => facts.push({ source, id, day: at.slice(0, 10), data });
  for (let ago = 56; ago >= 1; ago--) {
    const time = today - ago * DAY;
    const day = dateKey(time), at = (hours: number) => new Date(time + hours * 3_600_000).toISOString();
    for (const [s, service] of demoScope.services.entries()) {
      const repository = service.repository;
      const deployCount = (ago + s) % 7 === 0 ? 0 : 1 + ((ago + s) % 3);
      for (let j = 0; j < deployCount; j++) {
        const id = `${service.id}:${repository}:${ago * 10 + j}`;
        put('deployments', id, at(14 + j), { service: service.id, repository, delivered_at: at(14 + j), sha: `demo-${ago}-${j}` });
        for (let c = 0; c < 3; c++) {
          const hours = (ago > 28 ? 30 : 16) + ((ago + c * 3 + s) % 17);
          put('changes', `${id}:${c}`, at(14 + j), { service: service.id, repository, deployment: id, committed_at: new Date(Date.parse(at(14 + j)) - hours * 3_600_000).toISOString(), deployed_at: at(14 + j) });
        }
        if (ago % (ago > 28 ? 8 : 13) === 0 && j === 0) {
          put('incidents', `${service.id}:incident-${ago}`, at(15), { service: service.id, failed_at: at(15), recovered_at: at(ago > 28 ? 19 : 16.5), failed_deployments: [id], rework_deployments: deployCount > 1 ? [`${service.id}:${repository}:${ago * 10 + 1}`] : [] });
        }
      }
      const prCount = 3 + (ago + s) % 5;
      for (let j = 0; j < prCount; j++) {
        const id = `${repository}:${ago * 100 + j}`;
        const cycle = (ago > 28 ? 42 : 24) + ((ago + j) % 18);
        const created = new Date(Date.parse(at(12)) - cycle * 3_600_000).toISOString();
        put('pulls', id, created, { repository, created_at: created, merged_at: at(12), closed_at: at(12), bot: j === 0, author_id: 30 + j });
        put('reviews', `${id}:review`, at(8), { repository, pull_id: id, submitted_at: at(8), author_id: 30 + j, user_id: 100 + (ago + j) % 12, bot: false });
        put('commits', `${id}:commit`, at(9), { repository, committed_at: at(9), bot: j === 0 });
      }
      put('issues', `${repository}:issue-${ago}`, at(9), { repository, created_at: at(9), closed_at: at(17), bot: false });
      for (let j = 0; j < 8; j++) put('runs', `${repository}:run-${ago}-${j}`, at(10), {
        repository, created_at: at(10), started_at: at(10 + 2 / 60), status: 'completed',
        conclusion: (ago + j) % 17 === 0 ? 'failure' : 'success', attempt: (ago + j) % 13 === 0 ? 2 : 1,
      });
    }
    const active = 36 + (ago % 8) + (ago < 28 ? 12 : 0);
    const completions = 950 + (ago * 37 % 400);
    const accepted = Math.round(completions * (ago > 28 ? .29 : .37));
    const interactions = 420 + (ago * 31 % 250);
    put('copilot', day, day, {
      daily_active_users: active, weekly_active_users: ago < 28 ? 55 : 43, monthly_active_users: ago < 28 ? 55 : 43,
      monthly_active_agent_users: ago < 28 ? 55 : 43, monthly_active_chat_users: ago < 28 ? 51 : 40,
      daily_active_cli_users: 18, daily_active_copilot_app_users: 13, daily_active_vscode_agent_users: 26,
      daily_active_copilot_cloud_agent_users: 12, daily_active_copilot_code_review_users: 22, daily_passive_copilot_code_review_users: 8,
      user_initiated_interaction_count: interactions, code_generation_activity_count: completions + 130, code_acceptance_activity_count: accepted + 60,
      loc_suggested_to_add_sum: completions * 4, loc_added_sum: accepted * 4 + 420, loc_deleted_sum: 180 + ago,
      totals_by_feature: [
        { feature: 'code_completion', code_generation_activity_count: completions, code_acceptance_activity_count: accepted, user_initiated_interaction_count: 0 },
        { feature: 'agent', user_initiated_interaction_count: Math.round(interactions * .56) },
        { feature: 'chat', user_initiated_interaction_count: Math.round(interactions * .31) },
        { feature: 'edit', user_initiated_interaction_count: Math.round(interactions * .13) },
      ],
      totals_by_ide: [{ ide: 'VS Code', user_initiated_interaction_count: Math.round(interactions * .72) }, { ide: 'JetBrains', user_initiated_interaction_count: Math.round(interactions * .28) }],
      totals_by_language_feature: [{ language: 'TypeScript', code_generation_activity_count: 630 }, { language: 'Python', code_generation_activity_count: 320 }, { language: 'Go', code_generation_activity_count: 150 }],
      totals_by_model_feature: [{ model: 'Auto', user_initiated_interaction_count: 320 }, { model: 'Selected model', user_initiated_interaction_count: interactions - 320 }],
      totals_by_cli: { session_count: 32, prompt_count: 98, request_count: 205, token_usage: { prompt_tokens_sum: 180000, output_tokens_sum: 74000 } },
      totals_by_copilot_app: { session_count: 24, prompt_count: 61, request_count: 170, token_usage: { prompt_tokens_sum: 120000, output_tokens_sum: 52000 } },
      totals_by_vscode_agent: { session_count: 42, total_user_messages: 130 },
      pull_requests: { total_created: 15, total_merged: 13, total_created_by_copilot: 4, total_merged_created_by_copilot: 3, total_reviewed_by_copilot: 9, total_merged_reviewed_by_copilot: 7, total_copilot_suggestions: 32, total_copilot_applied_suggestions: 19, median_minutes_to_merge_copilot_authored: 120, median_minutes_to_merge_copilot_reviewed: 210 },
      totals_by_mcp: [{ mcp: 'GitHub', interaction_count: 80 }, { mcp: 'Documentation', interaction_count: 36 }],
    });
    for (let u = 0; u < 60; u++) {
      const distribute = (total: number) => u < active ? Math.floor(total / active) + (u < total % active ? 1 : 0) : 0;
      put('users', `${day}:${u}`, day, {
        user_id: u, used_agent: u < active,
        user_initiated_interaction_count: distribute(interactions),
        code_generation_activity_count: distribute(completions + 130),
        ai_credits_used: u < active ? 1.25 : 0, loc_added_sum: distribute(accepted * 4 + 420),
      });
      put('teams', `${day}:${u}`, day, { user_id: u, team_id: u < 30 ? 'checkout-team' : 'platform-team' });
    }
  }
  for (const service of demoScope.services) {
    put('observation', service.id, dateKey(today - DAY), { service: service.id, from: dateKey(today - 56 * DAY), to: dateKey(today - DAY) });
    for (let j = 0; j < 4; j++) put('pulls', `${service.repository}:open-${j}`, dateKey(today - (j + 1) * DAY), { repository: service.repository, created_at: new Date(today - (j + 1) * DAY).toISOString(), closed_at: null, merged_at: null, bot: false, author_id: 600 + j });
  }
  for (const [team, scores] of [['checkout-team', [4.2, 2.1, 4.1, 4.4, 4.3]], ['platform-team', [4.0, 2.4, 3.9, 4.2, 4.1]]] as const) {
    for (const [i, question] of ['satisfaction', 'friction', 'sustainability', 'copilot-usefulness', 'quality-outcome'].entries()) put('surveys', `${team}:${question}`, dateKey(today - DAY), {
      team, question, from: dateKey(today - 28 * DAY), to: dateKey(today - DAY), min: 1, max: 5, responses: 25, eligible: 30, score: scores[i],
    });
  }
  put('seats', 'latest', dateKey(today), { seats: 85 });
  return {
    facts,
    statuses: [
      ...demoScope.repositories.flatMap(repository => ['pulls', 'issues', 'runs', 'commits', 'deployments'].map(source => ({ source: `${source}:${repository}`, state: 'ready' as const, message: 'Synthetic demonstration evidence', updatedAt: new Date(today).toISOString(), from: dateKey(today - 56 * DAY), to: dateKey(today - DAY) }))),
      ...['copilot', 'users', 'teams', 'surveys', 'incidents'].map(source => ({ source, state: 'ready' as const, message: 'Synthetic demonstration evidence', updatedAt: new Date(today).toISOString(), from: dateKey(today - 56 * DAY), to: dateKey(today - DAY) })),
    ],
  };
}
