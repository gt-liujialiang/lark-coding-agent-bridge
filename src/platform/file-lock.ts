import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';

/**
 * Serialize access to `filePath` via a sibling `<filePath>.lock` file.
 * Shared lock/retry tuning for the app's small JSON file stores.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
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
