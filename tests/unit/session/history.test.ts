import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAgentPrompt } from '../../../src/agent/prompt.js';

describe('Claude local session history', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.doUnmock('node:os');
    vi.resetModules();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('listAllRecentSessions scans every project dir, sorts by mtime, extracts cwd from jsonl', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-all-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listAllRecentSessions } = await import('../../../src/session/history.js');

    // Two separate project dirs with one jsonl each. The "cwd" field inside
    // the jsonl is what should land in the result — NOT the encoded dirname.
    const dirOld = join(home, '.claude', 'projects', '-Users-x-proj-a');
    const dirNew = join(home, '.claude', 'projects', '-Users-x-proj-b');
    await mkdir(dirOld, { recursive: true });
    await mkdir(dirNew, { recursive: true });

    const oldJsonl = join(dirOld, 'sess-old.jsonl');
    const newJsonl = join(dirNew, 'sess-new.jsonl');
    await writeFile(
      oldJsonl,
      [
        JSON.stringify({ type: 'attachment', cwd: '/Users/x/proj/a' }),
        JSON.stringify({ type: 'user', message: { content: 'work on A' } }),
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(
      newJsonl,
      [
        JSON.stringify({ type: 'attachment', cwd: '/Users/x/proj/b' }),
        JSON.stringify({ type: 'user', message: { content: 'work on B' } }),
      ].join('\n') + '\n',
      'utf8',
    );
    await utimes(oldJsonl, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await utimes(newJsonl, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

    const out = await listAllRecentSessions(5);
    expect(out).toHaveLength(2);
    // Newest first.
    expect(out[0]?.sessionId).toBe('sess-new');
    expect(out[0]?.cwd).toBe('/Users/x/proj/b');
    expect(out[0]?.preview).toBe('work on B');
    expect(out[1]?.sessionId).toBe('sess-old');
    expect(out[1]?.cwd).toBe('/Users/x/proj/a');
  });

  it('listAllRecentSessions returns [] when ~/.claude/projects is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-empty-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listAllRecentSessions } = await import('../../../src/session/history.js');
    await expect(listAllRecentSessions(5)).resolves.toEqual([]);
  });

  it('listAllRecentSessions shortens home-rooted cwds to ~/...', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-short-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listAllRecentSessions } = await import('../../../src/session/history.js');

    const projectDir = join(home, '.claude', 'projects', '-home-rooted');
    await mkdir(projectDir, { recursive: true });
    const jsonl = join(projectDir, 's.jsonl');
    await writeFile(
      jsonl,
      JSON.stringify({ type: 'attachment', cwd: `${home}/github/foo` }) + '\n',
      'utf8',
    );

    const [hit] = await listAllRecentSessions(1);
    expect(hit?.cwd).toBe(`${home}/github/foo`);
    expect(hit?.cwdLabel).toBe('~/github/foo');
  });

  it('uses Claude project directory encoding for punctuation in cwd', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/Users/example/.lark-channel-workspaces/claude/default_open.sdks';
    const projectDir = join(
      home,
      '.claude',
      'projects',
      '-Users-example--lark-channel-workspaces-claude-default-open-sdks',
    );
    await mkdir(projectDir, { recursive: true });
    const sessionPath = join(projectDir, 'session-a.jsonl');
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: 'user', message: { content: 'resume me' } })}\n`,
      'utf8',
    );
    await utimes(sessionPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    await expect(listRecentSessions(cwd, 5)).resolves.toEqual([
      {
        sessionId: 'session-a',
        mtime: Date.parse('2026-01-01T00:00:00Z'),
        preview: 'resume me',
        lineCount: 1,
      },
    ]);
  });

  it('summarizes bridge prompts using the real user input section', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-history-home-'));
    cleanup.push(home);
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, homedir: () => home };
    });
    const { listRecentSessions } = await import('../../../src/session/history.js');

    const cwd = '/repo';
    const projectDir = join(home, '.claude', 'projects', '-repo');
    await mkdir(projectDir, { recursive: true });
    const prompt = buildAgentPrompt({
      context: {
        chatId: 'oc_secret',
        chatType: 'p2p',
        senderId: 'ou_secret',
        source: 'im',
      },
      instructions: ['internal bridge instruction'],
      userInput: '真实用户问题\n\n第二行',
    });
    await writeFile(
      join(projectDir, 'session-a.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: prompt } })}\n`,
      'utf8',
    );

    const sessions = await listRecentSessions(cwd, 5);

    expect(sessions[0]?.preview).toBe('真实用户问题 第二行');
  });
});
