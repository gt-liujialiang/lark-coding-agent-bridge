import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { withFileLock } from '../platform/file-lock';

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

/** Strict load: ENOENT → []; corrupt/non-array JSON → []; other IO errors THROW. */
async function loadForUpdate(filePath: string): Promise<ActiveUserRecord[]> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err; // EACCES/EBUSY/EIO — do not silently wipe the ledger
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isActiveUserRecord) : [];
  } catch {
    return []; // corrupt JSON is already unusable — start fresh
  }
}

/** 只读加载台账(尽力而为,永不抛出);文件缺失 / 损坏 / IO 错误 → 返回空数组。 */
export async function readActiveUsers(filePath: string): Promise<ActiveUserRecord[]> {
  try {
    return await loadForUpdate(filePath);
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
  await withFileLock(filePath, async () => {
    const records = await loadForUpdate(filePath);
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
