# Group Thread Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In regular (non-topic) Feishu group chats, the bot replies in-thread (starts/continues a 话题) instead of a flat quoted reply, gated by a new `/config` toggle that defaults on.

**Architecture:** A new config preference `replyInThreadInGroup` (default true) feeds a pure decision helper `shouldReplyInThread(mode, threadId, replyInThreadInGroup)` that the existing `runBatch` send path consults when building its shared `sendOpts`. Session scope is unchanged (one session per group). The reply-quote heuristic is generalized so in-thread structural parent links aren't mistaken for intentional quotes.

**Tech Stack:** TypeScript (ESM), `@larksuite/channel` SDK, vitest. Test imports use the `.js` extension (e.g. `../../../src/foo.js`). Verification script: `pnpm test && pnpm typecheck && pnpm build` (`pnpm ci:platform`).

---

### Task 1: `getReplyInThreadInGroup` config getter + preference field

**Files:**
- Modify: `src/config/schema.ts` (add field to `AppPreferences` ~line 111; add getter after `getRequireMentionInGroup` ~line 229)
- Test: `tests/unit/config/schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getReplyInThreadInGroup } from '../../../src/config/schema.js';
import type { AppConfig } from '../../../src/config/schema.js';

function cfgWith(replyInThreadInGroup: boolean | undefined): AppConfig {
  return {
    accounts: { app: { id: 'a', secret: 's', tenant: 't' } },
    preferences: replyInThreadInGroup === undefined ? {} : { replyInThreadInGroup },
  } as AppConfig;
}

describe('getReplyInThreadInGroup', () => {
  it('defaults to true when unset', () => {
    expect(getReplyInThreadInGroup(cfgWith(undefined))).toBe(true);
  });

  it('returns false only when explicitly false', () => {
    expect(getReplyInThreadInGroup(cfgWith(false))).toBe(false);
  });

  it('returns true when explicitly true', () => {
    expect(getReplyInThreadInGroup(cfgWith(true))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/config/schema.test.ts`
Expected: FAIL — `getReplyInThreadInGroup is not a function` / import error.

- [ ] **Step 3: Add the preference field**

In `src/config/schema.ts`, inside `interface AppPreferences` (after the `showToolCalls?` block, ~line 105), add:

```ts
  /**
   * Whether the bot replies in-thread (starts/continues a 话题) in regular
   * (non-topic) group chats. Default true. Topic-mode groups always thread
   * regardless; p2p never threads. Set false to keep flat quoted replies.
   */
  replyInThreadInGroup?: boolean;
```

- [ ] **Step 4: Add the getter**

In `src/config/schema.ts`, after `getRequireMentionInGroup` (ends ~line 229), add:

```ts
/**
 * Resolve the reply-in-thread-in-group preference. Default `true` — the
 * `!== false` check makes older configs without the field inherit the new
 * default. Only affects regular groups; topic groups thread unconditionally.
 */
export function getReplyInThreadInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.replyInThreadInGroup !== false;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/config/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/unit/config/schema.test.ts
git commit -m "feat(config): add replyInThreadInGroup preference (default on)"
```

---

### Task 2: `thread-policy.ts` — pure decision + quote-target helpers

**Files:**
- Create: `src/bot/thread-policy.ts`
- Test: `tests/unit/bot/thread-policy.test.ts` (create)

This task creates a standalone module so the threading decisions are unit-testable without loading the heavy `channel.ts` module. It hosts the new `shouldReplyInThread` and the relocated `replyQuoteTargetForMessage` (currently inline in `channel.ts`).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bot/thread-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  shouldReplyInThread,
  replyQuoteTargetForMessage,
} from '../../../src/bot/thread-policy.js';

function msg(partial: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    chatType: 'group',
    senderId: 's1',
    content: '',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 0,
    ...partial,
  } as NormalizedMessage;
}

describe('shouldReplyInThread', () => {
  it('topic group threads only when a threadId exists', () => {
    expect(shouldReplyInThread('topic', 'omt_1', true)).toBe(true);
    expect(shouldReplyInThread('topic', undefined, true)).toBe(false);
  });

  it('regular group follows the toggle', () => {
    expect(shouldReplyInThread('group', undefined, true)).toBe(true);
    expect(shouldReplyInThread('group', undefined, false)).toBe(false);
  });

  it('p2p never threads', () => {
    expect(shouldReplyInThread('p2p', undefined, true)).toBe(false);
  });
});

describe('replyQuoteTargetForMessage', () => {
  it('returns undefined when there is no reply target', () => {
    expect(replyQuoteTargetForMessage(msg({}))).toBeUndefined();
  });

  it('treats a reply to the thread root as structure, not a quote', () => {
    expect(
      replyQuoteTargetForMessage(
        msg({ replyToMessageId: 'root1', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBeUndefined();
  });

  it('returns an explicit quote to a non-root message', () => {
    expect(
      replyQuoteTargetForMessage(
        msg({ replyToMessageId: 'other', threadId: 'omt_1', rootId: 'root1' }),
      ),
    ).toBe('other');
  });

  it('returns the quote target for a plain (non-threaded) reply', () => {
    expect(replyQuoteTargetForMessage(msg({ replyToMessageId: 'q1' }))).toBe('q1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/bot/thread-policy.test.ts`
Expected: FAIL — module `src/bot/thread-policy.ts` not found.

- [ ] **Step 3: Create the module**

Create `src/bot/thread-policy.ts`:

```ts
import type { NormalizedMessage } from '@larksuite/channel';
import type { ChatMode } from './chat-mode-cache';

/**
 * Decide whether an outbound reply should be threaded (`reply_in_thread`).
 *
 * - topic-mode groups thread only when the triggering message already has a
 *   `threadId` (preserves the prior behavior);
 * - regular groups thread iff the operator-tunable toggle is on;
 * - p2p never threads.
 */
export function shouldReplyInThread(
  mode: ChatMode,
  threadId: string | undefined,
  replyInThreadInGroup: boolean,
): boolean {
  if (mode === 'topic') return Boolean(threadId);
  if (mode === 'group') return replyInThreadInGroup;
  return false;
}

/**
 * Resolve the message a reply should quote, or `undefined` when there's no
 * intentional quote. Feishu thread messages carry `root_id` as the thread
 * anchor even for ordinary in-thread messages (in topic groups AND in regular
 * groups that now carry threads) — that's structure, not a quote, so it's
 * filtered out. Non-threaded messages have no `threadId`, so the filter never
 * triggers for them.
 */
export function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;
  if (msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/bot/thread-policy.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/thread-policy.ts tests/unit/bot/thread-policy.test.ts
git commit -m "feat(bot): add thread-policy helpers (shouldReplyInThread, replyQuoteTargetForMessage)"
```

---

### Task 3: Wire thread-policy into `channel.ts`

**Files:**
- Modify: `src/bot/channel.ts` (imports ~line 5/38; `sendOpts` ~line 679-682; quote-target call ~line 656; remove inline `replyQuoteTargetForMessage` ~line 1237-1250)

No new test here — behavior is covered by Task 2's unit tests; this task rewires `channel.ts` to consume them. Correctness is confirmed by `pnpm typecheck` (no remaining references to the old inline function) and the existing suite.

- [ ] **Step 1: Add imports**

In `src/bot/channel.ts`, extend the existing `../config/schema` import block (currently lines 34-38) to include the new getter:

```ts
import {
  getMessageReplyMode,
  getRequireMentionInGroup,
  getReplyInThreadInGroup,
  getShowToolCalls,
} from '../config/schema';
```

Then add a new import for the thread-policy helpers (place it next to the `./chat-mode-cache` import, ~line 54):

```ts
import { shouldReplyInThread, replyQuoteTargetForMessage } from './thread-policy';
```

- [ ] **Step 2: Replace the `sendOpts` construction**

In `runBatch`, replace the current block (lines 676-682):

```ts
  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };
```

with:

```ts
  // Thread the reply when policy says so: topic groups (when the message is
  // in a thread) and regular groups when the operator toggle is on. p2p never
  // threads. All downstream send/stream sites reuse this single sendOpts.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(shouldReplyInThread(mode, threadId, getReplyInThreadInGroup(controls.cfg))
      ? { replyInThread: true }
      : {}),
  };
```

- [ ] **Step 3: Update the quote-target call site**

In `runBatch` (~line 656), the current mapping passes `mode`:

```ts
        .map((m) => replyQuoteTargetForMessage(m, mode))
```

Change it to drop the now-unused second argument:

```ts
        .map((m) => replyQuoteTargetForMessage(m))
```

- [ ] **Step 4: Remove the inline `replyQuoteTargetForMessage` definition**

Delete the entire inline function in `src/bot/channel.ts` (currently lines 1237-1250):

```ts
function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}
```

(It now lives in `thread-policy.ts`.)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If it reports `ChatMode`/`NormalizedMessage` imported but unused, remove the now-dead imports only if no other code in `channel.ts` uses them (both are used elsewhere — `ChatMode` in `runBatch` params, `NormalizedMessage` throughout — so expect no change needed).

- [ ] **Step 6: Run the bot test suite**

Run: `pnpm vitest run tests/unit/bot`
Expected: PASS (existing tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/bot/channel.ts
git commit -m "feat(bot): reply in-thread in regular groups via thread-policy"
```

---

### Task 4: Surface the toggle in the `/config` card

**Files:**
- Modify: `src/card/config-card.ts` (`ConfigFormOpts` ~line 11; form radio ~after line 185; saved-card summary ~line 266)
- Modify: `src/commands/index.ts` (form populate ~line 1749; parse submit ~line 1827; `nextPreferences` ~line 1862; log ~line 1906; `configSavedCard` opts ~line 1921)

No automated test — this is presentation wiring verified by `pnpm typecheck`/`build` and a manual `/config` check. The persistence path needs **no** change to `savePreferencesConfig`: `replyInThreadInGroup` is a plain preference, so it round-trips through the existing `nextPreferences` → `profilePreferences` spread.

- [ ] **Step 1: Extend `ConfigFormOpts`**

In `src/card/config-card.ts`, add to the `ConfigFormOpts` interface (after `requireMentionInGroup: boolean;`, line 11):

```ts
  replyInThreadInGroup: boolean;
```

- [ ] **Step 2: Add the form radio**

In `src/card/config-card.ts`, immediately after the `require_mention_in_group` `select_static` block (ends line 185, before the `lark-cli 身份策略` markdown at line 186), insert:

```ts
            {
              tag: 'markdown',
              content:
                '\n**群聊话题回复**\n' +
                '_是(默认):普通群里 bot 用「话题」回复每条消息,讨论更有条理_\n' +
                '_否:bot 直接引用回复,不开话题_\n' +
                '_话题群天生按话题组织,此项不影响它;私聊永远不开话题_',
            },
            {
              tag: 'select_static',
              name: 'reply_in_thread_in_group',
              initial_option: opts.replyInThreadInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是(默认)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
```

- [ ] **Step 3: Add the saved-card summary line**

In `src/card/config-card.ts`, in `configSavedCard`, after the `群里需要 @ bot` line (line 266) add:

```ts
            `**群聊话题回复**:\`${opts.replyInThreadInGroup ? '是' : '否'}\`\n` +
```

- [ ] **Step 4: Populate the form opts**

In `src/commands/index.ts`, in the `configFormCard({...})` call (~line 1744), add after `requireMentionInGroup: getRequireMentionInGroup(ctx.controls.cfg),` (line 1749):

```ts
    replyInThreadInGroup: getReplyInThreadInGroup(ctx.controls.cfg),
```

Ensure `getReplyInThreadInGroup` is imported from `../config/schema` at the top of the file (add it to the existing schema import group alongside `getRequireMentionInGroup`).

- [ ] **Step 5: Parse the submitted value**

In `src/commands/index.ts` `submitConfig`, after the `require_mention_in_group` parse block (ends line 1827), add:

```ts
  // Parse reply_in_thread_in_group. Empty / unexpected keeps current.
  const rawReplyInThread = String(fv.reply_in_thread_in_group ?? '').trim();
  let replyInThreadInGroup: boolean;
  if (rawReplyInThread === 'yes') replyInThreadInGroup = true;
  else if (rawReplyInThread === 'no') replyInThreadInGroup = false;
  else replyInThreadInGroup = getReplyInThreadInGroup(ctx.controls.cfg);
```

- [ ] **Step 6: Persist into preferences**

In `src/commands/index.ts`, in the `nextPreferences` object (~line 1851), add after `requireMentionInGroup,` (line 1862):

```ts
      replyInThreadInGroup,
```

- [ ] **Step 7: Add to the saved log and result card**

In `src/commands/index.ts`, in the `log.info('command', 'config-saved', {...})` call (~line 1901) add after `requireMentionInGroup,` (line 1906):

```ts
      replyInThreadInGroup,
```

And in the `configSavedCard({...})` call (~line 1916) add after `requireMentionInGroup,` (line 1921):

```ts
        replyInThreadInGroup,
```

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (`ConfigFormOpts` now requires `replyInThreadInGroup`; both call sites — `configFormCard` and `configSavedCard` — set it, so no type error.)

- [ ] **Step 9: Commit**

```bash
git add src/card/config-card.ts src/commands/index.ts
git commit -m "feat(config): surface 群聊话题回复 toggle in /config card"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full platform CI script**

Run: `pnpm ci:platform`
Expected: PASS — `vitest run` (all suites), `tsc --noEmit`, and `tsup` build all succeed.

- [ ] **Step 2: Manual sanity (optional, requires a live bot)**

In a regular group, @mention the bot and confirm the reply opens a 话题 anchored to your message. Open `/config`, confirm the **群聊话题回复** radio shows 是, toggle it to 否, submit, and confirm the next reply is a flat quoted reply (no thread).

- [ ] **Step 3: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for group thread reply"
```

---

## Self-Review Notes

- **Spec coverage:** schema field+getter (Task 1), core send decision + quote-target generalization (Tasks 2-3), `/config` card wiring (Task 4), testing + gate (Tasks 1-2 unit, Task 5 `ci:platform`). "NOT changing" items (session scope, policy fingerprint) are untouched — no task modifies `scope` derivation or `src/policy/fingerprint.ts`.
- **Type consistency:** `getReplyInThreadInGroup`, `shouldReplyInThread`, `replyQuoteTargetForMessage(msg)` (single arg), `replyInThreadInGroup` preference key, and the `reply_in_thread_in_group` form field name are used identically across all tasks.
- **Persistence:** confirmed `replyInThreadInGroup` is a plain preference (not `access`-scoped like `requireMentionInGroup`), so it flows through `normalizePreferences`'s `...rest` spread and `runtimeProfileConfig` without touching `savePreferencesConfig`.
