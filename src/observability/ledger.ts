import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export type ChatKind = 'p2p' | 'group' | 'topic';
export type Feedback = 'up' | 'down';
export interface VoteCounts {
  up: number;
  down: number;
}

/** One interaction: a completed agent run for a user in a chat, plus the
 * 👍/👎 votes people left on the reply card (one vote per person). */
export interface LedgerEntry {
  /** Stable key — the run id — so a later vote click finds this row. */
  id: string;
  at: number;
  openId: string;
  name?: string;
  chatId: string;
  chatKind: ChatKind;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** The bot's reply message that carries 👍/👎 reactions, so an incoming
   * reaction event can be attributed back to this interaction. */
  replyMessageId?: string;
  /** openId → their latest vote. One entry per person, switching allowed. */
  votes?: Record<string, Feedback>;
}

export interface RecordInteractionInput {
  id: string;
  openId: string;
  name?: string;
  chatId: string;
  chatKind: ChatKind;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  replyMessageId?: string;
  /** ms epoch; injected for tests, defaults to now. */
  at?: number;
}

export interface UserRollup {
  openId: string;
  name?: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  up: number;
  down: number;
}

export interface LedgerSummary {
  total: number;
  byChatKind: Record<ChatKind, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** Total votes across every card. */
  votes: VoteCounts;
  /** Per-user rollup, ranked by interaction count descending. */
  byUser: UserRollup[];
}

/**
 * Per-profile usage ledger. One row per completed interaction; each row also
 * accumulates 👍/👎 votes (one per person). Single bridge process writes, so
 * persistence is serialized through an in-memory promise chain (same pattern
 * as SessionStore) rather than an on-disk lock.
 */
export class LedgerStore {
  private entries: LedgerEntry[] = [];
  private byId = new Map<string, LedgerEntry>();
  private byReplyMessageId = new Map<string, LedgerEntry>();
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Best-effort load; missing file → empty, corrupt file → empty (start fresh). */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      const rows = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
      this.reindex(rows);
    } catch {
      this.reindex([]);
    }
  }

  private reindex(rows: LedgerEntry[]): void {
    this.entries = rows;
    this.byId = new Map(rows.map((r) => [r.id, r]));
    this.byReplyMessageId = new Map(
      rows.filter((r) => r.replyMessageId).map((r) => [r.replyMessageId as string, r]),
    );
  }

  record(input: RecordInteractionInput): void {
    const entry: LedgerEntry = {
      id: input.id,
      at: input.at ?? Date.now(),
      openId: input.openId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      chatId: input.chatId,
      chatKind: input.chatKind,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.replyMessageId !== undefined ? { replyMessageId: input.replyMessageId } : {}),
    };
    const prev = this.byId.get(entry.id);
    if (prev) {
      // Preserve any votes already left on this row.
      Object.assign(prev, entry, prev.votes ? { votes: prev.votes } : {});
      if (prev.replyMessageId) this.byReplyMessageId.set(prev.replyMessageId, prev);
    } else {
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
      if (entry.replyMessageId) this.byReplyMessageId.set(entry.replyMessageId, entry);
    }
    this.schedulePersist();
  }

  /**
   * Record `openId`'s vote on entry `id` (one per person, switching allowed).
   * Returns the entry's updated vote counts, or null if the id is unknown.
   */
  setVote(id: string, openId: string, feedback: Feedback): VoteCounts | null {
    const entry = this.byId.get(id);
    if (!entry) return null;
    if (!entry.votes) entry.votes = {};
    entry.votes[openId] = feedback;
    this.schedulePersist();
    return countVotes(entry);
  }

  /**
   * Apply a Feishu reaction (added/removed) on a bot reply message to the
   * matching interaction's votes. Native Feishu shows the live count; this
   * just mirrors it into the ledger for `/report`. No-op (false) if the
   * message isn't a tracked reply.
   */
  recordReaction(
    messageId: string,
    openId: string,
    feedback: Feedback,
    action: 'added' | 'removed',
  ): boolean {
    const entry = this.byReplyMessageId.get(messageId);
    if (!entry) return false;
    if (!entry.votes) entry.votes = {};
    if (action === 'added') {
      entry.votes[openId] = feedback;
    } else if (entry.votes[openId] === feedback) {
      delete entry.votes[openId];
    }
    this.schedulePersist();
    return true;
  }

  countsFor(id: string): VoteCounts {
    const entry = this.byId.get(id);
    return entry ? countVotes(entry) : { up: 0, down: 0 };
  }

  all(): LedgerEntry[] {
    return this.entries;
  }

  summarize(): LedgerSummary {
    const byChatKind: Record<ChatKind, number> = { p2p: 0, group: 0, topic: 0 };
    const votes: VoteCounts = { up: 0, down: 0 };
    const users = new Map<string, UserRollup>();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const e of this.entries) {
      byChatKind[e.chatKind] = (byChatKind[e.chatKind] ?? 0) + 1;
      const inTok = e.inputTokens ?? 0;
      const outTok = e.outputTokens ?? 0;
      const cost = e.costUsd ?? 0;
      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      totalCostUsd += cost;
      const c = countVotes(e);
      votes.up += c.up;
      votes.down += c.down;

      let u = users.get(e.openId);
      if (!u) {
        u = { openId: e.openId, count: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, up: 0, down: 0 };
        users.set(e.openId, u);
      }
      if (e.name) u.name = e.name;
      u.count += 1;
      u.inputTokens += inTok;
      u.outputTokens += outTok;
      u.costUsd += cost;
      u.up += c.up;
      u.down += c.down;
    }

    return {
      total: this.entries.length,
      byChatKind,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      votes,
      byUser: [...users.values()].sort((a, b) => b.count - a.count),
    };
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.entries, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('ledger', err, { step: 'persist' });
      });
  }
}

function countVotes(entry: LedgerEntry): VoteCounts {
  const counts: VoteCounts = { up: 0, down: 0 };
  for (const v of Object.values(entry.votes ?? {})) {
    if (v === 'up') counts.up += 1;
    else if (v === 'down') counts.down += 1;
  }
  return counts;
}

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.at === 'number' &&
    typeof e.openId === 'string' &&
    typeof e.chatId === 'string' &&
    (e.chatKind === 'p2p' || e.chatKind === 'group' || e.chatKind === 'topic')
  );
}
