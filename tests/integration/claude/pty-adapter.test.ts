import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../../src/agent/types.js';

const fakeBinary = fileURLToPath(new URL('../../fixtures/claude-fake/claude.mjs', import.meta.url));

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('ClaudeAdapter (PTY)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('runs a fresh turn end-to-end, reuses the PTY across two turns of the same session', { timeout: 30000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-pty-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'claude-pty-cwd-'));
    dirs.push(home, cwd);

    const turns = [
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
    ];

    const adapter = new ClaudeAdapter({
      binary: fakeBinary,
      homeOverride: home,
      readinessQuietMs: 0,
      env: { FAKE_CLAUDE_TURNS_JSON: JSON.stringify(turns) },
    });

    const r1 = adapter.run({ runId: 'r1', prompt: 'hi', cwd });
    const e1 = await collect(r1.events);
    expect(e1.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'a' });
    const sessionId = (e1.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();

    const r2 = adapter.run({ runId: 'r2', prompt: 'again', cwd, sessionId });
    const e2 = await collect(r2.events);
    expect(e2.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'b' });

    await adapter.closeSession?.(sessionId!);
  });

  it('forwards permissionMode to the spawned PTY process', { timeout: 30000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-pty-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'claude-pty-cwd-'));
    const argsFile = join(tmpdir(), `claude-args-${Date.now()}.json`);
    dirs.push(home, cwd);

    const adapter = new ClaudeAdapter({
      binary: fakeBinary,
      homeOverride: home,
      readinessQuietMs: 0,
      env: {
        FAKE_CLAUDE_RECORD_ARGS_PATH: argsFile,
        FAKE_CLAUDE_TURNS_JSON: JSON.stringify([
          [{ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }],
        ]),
      },
    });

    const r = adapter.run({ runId: 'r-pm', prompt: 'hi', cwd, permissionMode: 'acceptEdits' });
    const events = await collect(r.events);
    const sessionId = (events.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();

    const recorded = JSON.parse(await readFile(argsFile, 'utf8')) as string[];
    const pmIdx = recorded.indexOf('--permission-mode');
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(recorded[pmIdx + 1]).toBe('acceptEdits');

    await adapter.closeSession?.(sessionId!);
  });

  it('closeSession releases the session so a follow-up acquires a fresh one', { timeout: 30000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-pty-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'claude-pty-cwd-'));
    dirs.push(home, cwd);

    const adapter = new ClaudeAdapter({
      binary: fakeBinary,
      homeOverride: home,
      readinessQuietMs: 0,
      env: { FAKE_CLAUDE_TURNS_JSON: JSON.stringify([
        [{ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }], stop_reason: 'end_turn', usage: {} } }],
      ]) },
    });

    const r = adapter.run({ runId: 'r', prompt: 'hi', cwd });
    const events = await collect(r.events);
    const id = (events.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId!;
    await adapter.closeSession?.(id);

    // A fresh run with the same (now-released) id falls back to a new spawn.
    const r2 = adapter.run({ runId: 'r2', prompt: 'fresh', cwd, sessionId: id });
    const e2 = await collect(r2.events);
    expect((e2.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId).not.toBe(id);
  });
});
