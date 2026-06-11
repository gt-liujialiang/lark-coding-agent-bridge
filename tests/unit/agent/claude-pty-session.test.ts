import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';
import { PtySession } from '../../../src/agent/claude/pty-session.js';
import type { PtyHandle } from '../../../src/agent/claude/pty.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function createStubPty(): {
  handle: PtyHandle;
  writes: string[];
  emitData: (s: string) => void;
  emitExit: (code: number, signal?: number) => void;
} {
  const writes: string[] = [];
  const dataListeners: ((s: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  return {
    writes,
    emitData: (s) => dataListeners.forEach((l) => l(s)),
    emitExit: (code, signal) => exitListeners.forEach((l) => l({ exitCode: code, signal })),
    handle: {
      pid: 1234,
      write: (d) => writes.push(d),
      resize: () => {},
      onData: (l) => { dataListeners.push(l); },
      onExit: (l) => { exitListeners.push(l); },
      kill: () => {},
    },
  };
}

describe('PtySession', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeJsonlHome(cwd: string, sessionId: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'pty-session-home-'));
    dirs.push(home);
    const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
    await mkdir(dir, { recursive: true });
    return home;
  }

  it('writes the prompt + delay + CR to the PTY and emits events drained from the JSONL', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-1';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    // Pre-populate the JSONL with two entries so runTurn finds them quickly.
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    setTimeout(async () => {
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi back' }] },
      }) + '\n');
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      }) + '\n');
    }, 20);

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('hello')) events.push(ev);

    expect(stub.writes[0]).toBe('hello');
    expect(stub.writes[1]).toBe('\r');
    expect(events).toEqual([
      { type: 'text', delta: 'hi back' },
      { type: 'usage', inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('flattens internal newlines so the TUI sees one line + Submit', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-newlines';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    setTimeout(async () => {
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: { content: [], stop_reason: 'end_turn', usage: {} },
      }) + '\n');
    }, 20);

    for await (const _ of session.runTurn('line1\nline2\r\nline3')) { /* drain */ }

    expect(stub.writes[0]).toBe('line1 line2 line3');
    expect(stub.writes[1]).toBe('\r');
  });

  it('handles the "trust this folder" consent dialog by pressing Enter (one-time)', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-trust';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });
    void session;

    stub.emitData('Quick safety check: Is this a project you trust?\n  1. Yes, I trust this folder\n  2. No, exit\n');

    // Dialog response is debounced 100ms so the redraw settles first.
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.writes).toContain('\r');
    const trustPresses = stub.writes.filter((w) => w === '\r').length;
    expect(trustPresses).toBeGreaterThanOrEqual(1);

    // Re-emitting the same string must not re-press.
    stub.emitData('Yes, I trust this folder\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes.filter((w) => w === '\r').length).toBe(trustPresses);
  });

  it('handles the "Bypass Permissions" consent by pressing 2 (one-time)', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-bypass';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });
    void session;

    stub.emitData('Bypass Permissions mode\n  1. No, exit\n  2. Yes, I accept\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(stub.writes).toContain('2\r');

    const before = stub.writes.filter((w) => w === '2\r').length;
    stub.emitData('Yes, I accept\n');
    await new Promise((r) => setTimeout(r, 150));
    expect(stub.writes.filter((w) => w === '2\r').length).toBe(before);
  });

  it('softInterrupt writes ESC and resolves done(interrupted) if the turn does not complete in grace', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-3';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    const iter = session.runTurn('long task')[Symbol.asyncIterator]();
    setTimeout(() => { void session.softInterrupt(20); }, 30);

    const ev = await iter.next();
    expect(ev.done).toBe(false);
    expect(ev.value).toEqual({ type: 'done', terminationReason: 'interrupted' });

    expect(stub.writes).toContain('\x1b');
  });

  it('emits error(failed) and stops iteration when the PTY exits mid-turn', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-4';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
      readinessQuietMs: 0,
    });

    setTimeout(() => stub.emitExit(1, undefined), 30);

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('bye')) events.push(ev);

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: expect.stringMatching(/exited/i) as unknown as string,
      terminationReason: 'failed',
    });
    expect(session.isAlive()).toBe(false);
  });
});
