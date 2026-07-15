import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readActiveUsers,
  recordActiveUser,
} from '../../../src/observability/active-users.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'active-users-'));
  file = join(dir, 'active-users.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('active-users store', () => {
  it('returns empty array when file missing', async () => {
    expect(await readActiveUsers(file)).toEqual([]);
  });

  it('creates a record on first sight', async () => {
    await recordActiveUser(file, {
      openId: 'ou_1',
      name: '张三',
      chatId: 'oc_1',
      chatType: 'p2p',
      at: '2026-07-15T10:00:00.000Z',
    });
    const users = await readActiveUsers(file);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      openId: 'ou_1',
      name: '张三',
      chatId: 'oc_1',
      chatType: 'p2p',
      firstSeenAt: '2026-07-15T10:00:00.000Z',
      lastSeenAt: '2026-07-15T10:00:00.000Z',
      messageCount: 1,
    });
  });

  it('increments count and updates lastSeen/name/chat on repeat', async () => {
    await recordActiveUser(file, {
      openId: 'ou_1', name: '张三', chatId: 'oc_1', chatType: 'p2p',
      at: '2026-07-15T10:00:00.000Z',
    });
    await recordActiveUser(file, {
      openId: 'ou_1', name: '张三丰', chatId: 'oc_2', chatType: 'group',
      at: '2026-07-15T11:00:00.000Z',
    });
    const users = await readActiveUsers(file);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      messageCount: 2,
      name: '张三丰',
      chatId: 'oc_2',
      chatType: 'group',
      firstSeenAt: '2026-07-15T10:00:00.000Z',
      lastSeenAt: '2026-07-15T11:00:00.000Z',
    });
  });

  it('tracks multiple distinct users', async () => {
    await recordActiveUser(file, { openId: 'ou_1', chatId: 'oc_1', chatType: 'p2p', at: '2026-07-15T10:00:00.000Z' });
    await recordActiveUser(file, { openId: 'ou_2', chatId: 'oc_1', chatType: 'p2p', at: '2026-07-15T10:01:00.000Z' });
    expect(await readActiveUsers(file)).toHaveLength(2);
  });

  it('does not lose updates under sequential concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordActiveUser(file, {
          openId: 'ou_1', chatId: 'oc_1', chatType: 'p2p',
          at: `2026-07-15T10:0${i}:00.000Z`,
        }),
      ),
    );
    const users = await readActiveUsers(file);
    expect(users).toHaveLength(1);
    expect(users[0]?.messageCount).toBe(5);
  });

  it('returns empty array on corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json{{{');
    expect(await readActiveUsers(file)).toEqual([]);
  });
});
