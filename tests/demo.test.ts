import { expect, it } from 'vitest';
import { activeUser } from '../packages/metrics/engine.js';
import { demoDataset } from '../packages/metrics/demo.js';

it('keeps synthetic source totals and per-user facts internally consistent', () => {
  const data = demoDataset(Date.parse('2026-10-19'));
  for (const day of data.facts.filter(f => f.source === 'copilot')) {
    const users = data.facts.filter(f => f.source === 'users' && f.day === day.day);
    expect(users.filter(f => activeUser(f.data)).length).toBe(day.data.daily_active_users);
    expect(users.reduce((sum, f) => sum + Number(f.data.user_initiated_interaction_count), 0)).toBe(day.data.user_initiated_interaction_count);
    expect(users.reduce((sum, f) => sum + Number(f.data.loc_added_sum), 0)).toBe(day.data.loc_added_sum);
    expect(Number(day.data.daily_active_users)).toBeLessThanOrEqual(Number(day.data.weekly_active_users));
    expect(Number(day.data.weekly_active_users)).toBeLessThanOrEqual(Number(day.data.monthly_active_users));
  }
});
