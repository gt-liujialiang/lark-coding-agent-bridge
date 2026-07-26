import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

// Feishu message events carry only the sender's open_id, not their display
// name. Resolve names on demand via the contact API and cache per process.
const cache = new Map<string, string>();

interface ContactUserGet {
  contact: {
    v3: {
      user: {
        get(req: {
          path: { user_id: string };
          params: { user_id_type: string };
        }): Promise<{ data?: { user?: { name?: string } } }>;
      };
    };
  };
}

/**
 * Resolve open_id → display name for the given ids (deduped, cached). Missing
 * or failed lookups (e.g. the app lacks the contact scope) are simply absent
 * from the result — callers fall back to a short id.
 */
export async function resolveUserNames(
  channel: LarkChannel,
  openIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(openIds)) {
    const cached = cache.get(id);
    if (cached !== undefined) out.set(id, cached);
    else missing.push(id);
  }
  if (missing.length === 0) return out;

  const client = channel.rawClient as unknown as ContactUserGet;
  await Promise.all(
    missing.map(async (openId) => {
      try {
        const res = await client.contact.v3.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        });
        const name = res?.data?.user?.name;
        if (typeof name === 'string' && name.trim()) {
          cache.set(openId, name);
          out.set(openId, name);
          log.info('user-names', 'resolved', { openId: openId.slice(-6), name });
        } else {
          // Call succeeded but the user object carries no `name` — the app
          // has only ID-level contact scope. Needs `contact:user.base:readonly`
          // ("获取用户基本信息") to expose the display name.
          log.warn('user-names', 'no-name-field', {
            openId: openId.slice(-6),
            hint: 'grant contact:user.base:readonly',
          });
        }
      } catch (err) {
        // Surface the real Feishu error code/msg (buried in the response body),
        // not just axios's generic "status code 400".
        const body = (err as { response?: { data?: unknown } })?.response?.data;
        log.warn('user-names', 'lookup-failed', {
          openId: openId.slice(-6),
          err: err instanceof Error ? err.message : String(err),
          feishu: body ? JSON.stringify(body).slice(0, 300) : undefined,
        });
      }
    }),
  );
  return out;
}
