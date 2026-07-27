export interface PtySessionLike {
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  hardClose(graceMs?: number): Promise<void>;
}

export interface PtySessionFactoryInput {
  cwd: string;
  /** Existing claude session id to resume; undefined ⇒ assign a fresh uuid. */
  sessionId: string | undefined;
  /** Claude model to use when spawning a new PTY. Ignored on pool hits. */
  model?: string;
  /** Optional permission mode. Baked at PTY spawn time; pool hit keeps the
   * existing PTY's permission mode regardless of subsequent requests. */
  permissionMode?: string;
}

export type PtySessionFactory = (input: PtySessionFactoryInput) => Promise<PtySessionLike>;

export interface ClaudePtyPoolOptions {
  factory: PtySessionFactory;
  /** Idle TTL before reaper closes a session. Default 30 min. */
  idleTtlMs?: number;
  /** Sweep interval. Default 60s; tests can override. */
  sweepIntervalMs?: number;
}

interface PoolEntry {
  session: PtySessionLike;
  lastUsedAt: number;
}

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 1000;

export class ClaudePtyPool {
  private readonly bySession = new Map<string, PoolEntry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly opts: ClaudePtyPoolOptions) {
    const sweep = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.sweeper = setInterval(() => {
      void this.reap();
    }, sweep);
    // Don't keep the event loop alive just for the reaper.
    this.sweeper.unref?.();
  }

  /**
   * Get an existing live session by id (pool hit) or spawn a new one. Missing
   * `sessionId` always spawns fresh; the factory is expected to allocate a new
   * uuid in that case and return it via `session.sessionId`.
   */
  async acquire(input: PtySessionFactoryInput): Promise<PtySessionLike> {
    if (input.sessionId !== undefined) {
      const existing = this.bySession.get(input.sessionId);
      if (existing && existing.session.isAlive()) {
        existing.lastUsedAt = Date.now();
        return existing.session;
      }
      if (existing && !existing.session.isAlive()) {
        this.bySession.delete(input.sessionId);
      }
    }
    const session = await this.opts.factory(input);
    this.bySession.set(session.sessionId, { session, lastUsedAt: Date.now() });
    return session;
  }

  /** Bump last-used so an active turn isn't reaped mid-loop. */
  touch(sessionId: string): void {
    const entry = this.bySession.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.bySession.get(sessionId);
    if (!entry) return;
    this.bySession.delete(sessionId);
    try {
      await entry.session.hardClose();
    } catch {
      // best-effort; the entry is already removed
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.bySession.values()];
    this.bySession.clear();
    await Promise.all(entries.map((e) => e.session.hardClose().catch(() => undefined)));
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  private async reap(): Promise<void> {
    const ttl = this.opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, entry] of this.bySession) {
      if (!entry.session.isAlive() || now - entry.lastUsedAt > ttl) {
        stale.push(id);
      }
    }
    for (const id of stale) {
      await this.release(id);
    }
  }
}
