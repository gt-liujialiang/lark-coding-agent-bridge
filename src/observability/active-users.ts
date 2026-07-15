import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ActiveUserRecord {
  openId: string;
  name?: string;
  /** 最近一次提问所在 chat。 */
  chatId: string;
  /** p2p | group | ... */
  chatType: string;
  /** ISO 时间戳。 */
  firstSeenAt: string;
  lastSeenAt: string;
  messageCount: number;
}

export interface RecordActiveUserInput {
  openId: string;
  name?: string;
  chatId: string;
  chatType: string;
  /** ISO 时间戳;缺省取当前时间(注入便于测试)。 */
  at?: string;
}

/** 只读加载台账;文件缺失 / 损坏 / 非数组 → 返回空数组。 */
export async function readActiveUsers(filePath: string): Promise<ActiveUserRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isActiveUserRecord) : [];
  } catch {
    return [];
  }
}

/** upsert 一条活跃用户记录(按 openId)。并发安全(proper-lockfile)。 */
export async function recordActiveUser(
  filePath: string,
  input: RecordActiveUserInput,
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await withLedgerLock(filePath, async () => {
    const records = await readActiveUsers(filePath);
    const existing = records.find((r) => r.openId === input.openId);
    if (existing) {
      existing.messageCount += 1;
      existing.lastSeenAt = at;
      existing.chatId = input.chatId;
      existing.chatType = input.chatType;
      if (input.name) existing.name = input.name;
    } else {
      records.push({
        openId: input.openId,
        ...(input.name ? { name: input.name } : {}),
        chatId: input.chatId,
        chatType: input.chatType,
        firstSeenAt: at,
        lastSeenAt: at,
        messageCount: 1,
      });
    }
    await writeFileAtomic(filePath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  });
}

async function withLedgerLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = `${filePath}.lock`;
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  await chmod(lockTarget, 0o600).catch(() => {});
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function isActiveUserRecord(v: unknown): v is ActiveUserRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.openId === 'string' &&
    typeof r.chatId === 'string' &&
    typeof r.chatType === 'string' &&
    typeof r.firstSeenAt === 'string' &&
    typeof r.lastSeenAt === 'string' &&
    typeof r.messageCount === 'number'
  );
}
