import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { generateCopilotSummary, createCopilotSummaryPayload } from '../apps/server/copilot-summary.js';
import { calculate } from '../packages/metrics/engine.js';
import { dataset, filters, scope } from './fixtures.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

describe('Copilot CLI invocation', () => {
  const payload = () => createCopilotSummaryPayload(calculate(dataset([]), scope, filters), ['Copilot']);
  const fakeProcess = (code: number, stdout: string, stderr: string) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    spawn.mockImplementationOnce(() => {
      setImmediate(() => {
        child.stdout.write(stdout);
        child.stderr.write(stderr);
        child.emit('close', code);
      });
      return child;
    });
  };

  it('uses a supported credit ceiling and excludes diagnostics from the summary', async () => {
    fakeProcess(0, 'Evidence is limited.', 'CLI warning');
    expect(await generateCopilotSummary(payload())).toBe('Evidence is limited.');
    const args = spawn.mock.lastCall?.[1];
    expect(args).toContain('--max-ai-credits=30');
    expect(args).not.toContain('--max-ai-credits=1');
    expect(args?.[args.length - 1]).toBe('--available-tools');
  });

  it('reports account restrictions without returning raw CLI diagnostics', async () => {
    fakeProcess(1, '', 'Authentication failed: Your account was suspended. sensitive-detail');
    await expect(generateCopilotSummary(payload())).rejects.toThrow('GitHub rejected the account used by Copilot CLI as suspended.');
  });

  it('reports authentication failures without exposing diagnostic details', async () => {
    fakeProcess(1, '', 'Authentication token could not be validated: sensitive-detail');
    await expect(generateCopilotSummary(payload())).rejects.toMatchObject({
      status: 503,
      message: 'Copilot CLI authentication failed. Run `copilot login` with an authorized account, then retry.',
    });
  });

  it('rejects empty output rather than treating it as a successful summary', async () => {
    fakeProcess(0, '  ', '');
    await expect(generateCopilotSummary(payload())).rejects.toMatchObject({
      status: 502,
      message: 'Copilot CLI returned an empty or oversized summary.',
    });
  });
});
