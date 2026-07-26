import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '../../../src/observability/ledger';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-test-'));
  dirs.push(dir);
  return join(dir, 'ledger.json');
}

describe('LedgerStore', () => {
  it('records an interaction and reads it back', async () => {
    const store = new LedgerStore(await tmpFile());
    store.record({
      id: 'run-1',
      openId: 'ou_a',
      name: 'Alice',
      chatId: 'oc_x',
      chatKind: 'p2p',
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      at: 1000,
    });
    await store.flush();

    expect(store.all()).toEqual([
      {
        id: 'run-1',
        at: 1000,
        openId: 'ou_a',
        name: 'Alice',
        chatId: 'oc_x',
        chatKind: 'p2p',
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
      },
    ]);
  });

  it('persists atomically and reloads from disk', async () => {
    const path = await tmpFile();
    const store = new LedgerStore(path);
    store.record({ id: 'r1', openId: 'ou_a', chatId: 'oc', chatKind: 'group', at: 1 });
    store.setVote('r1', 'ou_b', 'up');
    await store.flush();

    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw).toHaveLength(1);

    const reloaded = new LedgerStore(path);
    await reloaded.load();
    expect(reloaded.all()[0]?.id).toBe('r1');
    expect(reloaded.countsFor('r1')).toEqual({ up: 1, down: 0 });
  });

  it('counts one vote per person and lets a person switch their vote', async () => {
    const store = new LedgerStore(await tmpFile());
    store.record({ id: 'r1', openId: 'ou_owner', chatId: 'oc', chatKind: 'group', at: 1 });

    expect(store.setVote('r1', 'ou_a', 'up')).toEqual({ up: 1, down: 0 });
    expect(store.setVote('r1', 'ou_b', 'up')).toEqual({ up: 2, down: 0 });
    // Same person clicking again stays one vote (idempotent).
    expect(store.setVote('r1', 'ou_a', 'up')).toEqual({ up: 2, down: 0 });
    // Person switches from 👍 to 👎.
    expect(store.setVote('r1', 'ou_a', 'down')).toEqual({ up: 1, down: 1 });
  });

  it('returns null when voting on an unknown id', async () => {
    const store = new LedgerStore(await tmpFile());
    expect(store.setVote('missing', 'ou_a', 'up')).toBeNull();
  });

  it('applies reactions on the reply message and can remove them', async () => {
    const store = new LedgerStore(await tmpFile());
    store.record({ id: 'r1', openId: 'ou_owner', chatId: 'oc', chatKind: 'group', replyMessageId: 'om_reply', at: 1 });

    expect(store.recordReaction('om_reply', 'ou_a', 'up', 'added')).toBe(true);
    expect(store.recordReaction('om_reply', 'ou_b', 'down', 'added')).toBe(true);
    expect(store.countsFor('r1')).toEqual({ up: 1, down: 1 });

    // Removing ou_a's 👍 drops it.
    expect(store.recordReaction('om_reply', 'ou_a', 'up', 'removed')).toBe(true);
    expect(store.countsFor('r1')).toEqual({ up: 0, down: 1 });

    // Reaction on an untracked message is a no-op.
    expect(store.recordReaction('om_other', 'ou_a', 'up', 'added')).toBe(false);
  });

  it('reindexes replyMessageId after reload so reactions still attribute', async () => {
    const path = await tmpFile();
    const store = new LedgerStore(path);
    store.record({ id: 'r1', openId: 'ou_o', chatId: 'oc', chatKind: 'p2p', replyMessageId: 'om_reply', at: 1 });
    await store.flush();

    const reloaded = new LedgerStore(path);
    await reloaded.load();
    expect(reloaded.recordReaction('om_reply', 'ou_a', 'up', 'added')).toBe(true);
    expect(reloaded.countsFor('r1')).toEqual({ up: 1, down: 0 });
  });

  it('countsFor an entry with no votes is zero', async () => {
    const store = new LedgerStore(await tmpFile());
    store.record({ id: 'r1', openId: 'ou_a', chatId: 'oc', chatKind: 'p2p', at: 1 });
    expect(store.countsFor('r1')).toEqual({ up: 0, down: 0 });
  });

  it('summarizes totals by chat kind, user, tokens, cost and votes', async () => {
    const store = new LedgerStore(await tmpFile());
    store.record({ id: 'r1', openId: 'ou_a', name: 'Alice', chatId: 'oc1', chatKind: 'p2p', inputTokens: 100, outputTokens: 40, costUsd: 0.02, at: 1 });
    store.record({ id: 'r2', openId: 'ou_a', name: 'Alice', chatId: 'oc2', chatKind: 'group', inputTokens: 200, outputTokens: 60, costUsd: 0.05, at: 2 });
    store.record({ id: 'r3', openId: 'ou_b', name: 'Bob', chatId: 'oc2', chatKind: 'group', inputTokens: 50, outputTokens: 10, costUsd: 0.01, at: 3 });
    // r1 gets 👍 from two people; r2 gets 👎 from one.
    store.setVote('r1', 'ou_a', 'up');
    store.setVote('r1', 'ou_b', 'up');
    store.setVote('r2', 'ou_c', 'down');

    const s = store.summarize();
    expect(s.total).toBe(3);
    expect(s.byChatKind).toMatchObject({ p2p: 1, group: 2 });
    expect(s.totalInputTokens).toBe(350);
    expect(s.totalOutputTokens).toBe(110);
    expect(s.totalCostUsd).toBeCloseTo(0.08, 6);
    // Total votes across all cards.
    expect(s.votes).toEqual({ up: 2, down: 1 });

    // Per-user rollup attributes votes to the interaction's owner (the person
    // who made the request), aggregating votes their replies received.
    const alice = s.byUser.find((u) => u.openId === 'ou_a');
    expect(alice).toMatchObject({ name: 'Alice', count: 2, inputTokens: 300, outputTokens: 100, up: 2, down: 1 });
    expect(alice?.costUsd).toBeCloseTo(0.07, 6);
    expect(s.byUser[0]?.openId).toBe('ou_a');
  });

  it('survives a corrupt ledger file by starting empty', async () => {
    const path = await tmpFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, 'not json', 'utf8');
    const store = new LedgerStore(path);
    await store.load();
    expect(store.all()).toEqual([]);
  });
});
