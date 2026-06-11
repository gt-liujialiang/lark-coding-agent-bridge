import { describe, expect, it, vi } from 'vitest';
import { ClaudePtyPool, type PtySessionLike } from '../../../src/agent/claude/pty-pool.js';

function fakeSession(sessionId: string): PtySessionLike & { closed: boolean } {
  const s = {
    sessionId,
    cwd: '/tmp',
    closed: false,
    isAlive: () => !s.closed,
    hardClose: vi.fn(async () => {
      s.closed = true;
    }),
    softInterrupt: vi.fn(async () => {}),
    runTurn: vi.fn(),
    syncCursorToTail: vi.fn(async () => {}),
  } as unknown as PtySessionLike & { closed: boolean };
  return s;
}

describe('ClaudePtyPool', () => {
  it('spawns a new session on miss, reuses on hit', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) => {
      return fakeSession(input.sessionId ?? 'fresh-id');
    });
    const pool = new ClaudePtyPool({ factory, idleTtlMs: 60_000 });

    const a = await pool.acquire({ cwd: '/tmp', sessionId: undefined });
    expect(factory).toHaveBeenCalledTimes(1);
    const b = await pool.acquire({ cwd: '/tmp', sessionId: a.sessionId });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('release closes and forgets a session', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) =>
      fakeSession(input.sessionId ?? 'x'),
    );
    const pool = new ClaudePtyPool({ factory, idleTtlMs: 60_000 });
    const a = await pool.acquire({ cwd: '/tmp', sessionId: 'a' });

    await pool.release('a');
    expect((a as unknown as { hardClose: ReturnType<typeof vi.fn> }).hardClose).toHaveBeenCalled();

    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reaps sessions whose last use is older than the TTL', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) =>
      fakeSession(input.sessionId ?? 'x'),
    );
    const pool = new ClaudePtyPool({
      factory,
      idleTtlMs: 5,
      sweepIntervalMs: 1,
    });
    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    await new Promise((r) => setTimeout(r, 30));
    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
    pool.stop();
  });

  it('replaces a dead session even when its id matches', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) =>
      fakeSession(input.sessionId ?? 'x'),
    );
    const pool = new ClaudePtyPool({ factory, idleTtlMs: 60_000 });
    const first = (await pool.acquire({ cwd: '/tmp', sessionId: 'a' })) as unknown as {
      closed: boolean;
    };
    first.closed = true;
    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
