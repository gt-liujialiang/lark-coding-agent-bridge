# 普通群聊话题回复 (In-thread replies for regular groups)

**Date:** 2026-06-30
**Branch:** `feat/thread-reply`
**Status:** Approved design — ready for implementation plan

## Goal

In **regular (non-topic) group chats**, the bot's replies should start (or continue)
a Feishu thread (话题) anchored to the triggering message, instead of today's flat
quoted reply. The behavior is gated by a new config toggle, **default on**, and is
surfaced in the `/config` interactive card alongside `requireMentionInGroup`.

Session scope stays **per-group** (one shared conversation per group, `scope = chatId`).
Threads are a presentation concern only — they do not split sessions.

## Background

The current project already does in-thread replies for **topic-mode groups**
(`chatMode === 'topic'`, detected automatically via `channel.getChatMode()`).
That path scopes sessions per-thread (`scope = chatId:threadId`) and sends with
`replyInThread: true` (`src/bot/channel.ts:681`).

Regular groups (`chatMode === 'group'`) currently get only a flat quoted reply
(`replyTo: lastMsg.messageId`, no `replyInThread`). The reference project
(`feishu-claude-code`, Python) has no thread support at all — it uses `areply`
(a quoted reply), so there is no implementation to copy; this design adds the
behavior natively using the existing `@larksuite/channel` SDK.

## Behavior

| Context | Today | After |
|---|---|---|
| p2p | flat | **unchanged** (never threaded) |
| topic-mode group | in-thread | **unchanged** |
| regular group, toggle **on** (default) | flat quote | `replyInThread: true` — each top-level @bot message spawns its own thread; @bot inside an existing thread continues it |
| regular group, toggle **off** | flat quote | flat quote (current behavior) |

- The first top-level message in a regular group has no `threadId`; sending the
  reply with `replyInThread: true` + `replyTo` is what *creates* the thread.
- The toggle is re-read per flush (like `messageReply` / `requireMentionInGroup`),
  so `/config` changes take effect immediately without restart.

## Components

### 1. `src/config/schema.ts`
- Add `replyInThreadInGroup?: boolean` to `AppPreferences`, with a doc comment
  explaining default-on and that it only affects regular (non-topic) groups.
- Add getter `getReplyInThreadInGroup(cfg: AppConfig): boolean` defaulting to `true`
  via the `!== false` pattern (mirrors `getRequireMentionInGroup`, so older configs
  without the field inherit the new default).

### 2. `src/bot/channel.ts` — `runBatch` (~line 679, core change)
Extend the single `sendOpts` object that every send/stream site already shares:

```ts
const threadRegular = mode === 'group' && getReplyInThreadInGroup(controls.cfg);
const sendOpts = {
  replyTo: lastMsg.messageId,
  ...(((mode === 'topic' && threadId) || threadRegular) ? { replyInThread: true } : {}),
};
```

Because card / markdown / text reply modes, the rejection message
(`channel.send(... sendOpts)`), and the stream fallback all reuse `sendOpts`, the
threading applies consistently with no other edits in the send paths.

To make the decision unit-testable in isolation, extract the `replyInThread`
predicate into a small pure helper (e.g. `shouldReplyInThread(mode, threadId,
replyInThreadInGroup)`) — `runBatch` calls it when building `sendOpts`.

### 3. `src/bot/channel.ts` — `replyQuoteTargetForMessage` (~line 1237)
Generalize the thread-structure filter so it no longer requires `mode === 'topic'`:

```ts
// Thread messages use root_id as the thread anchor even for ordinary in-thread
// messages. Treat that as structure, not an intentional quote — in topic groups
// AND in regular groups that now carry threads.
if (msg.threadId && msg.rootId && replyTo === msg.rootId) {
  return undefined;
}
```

Safe: non-threaded messages have no `threadId`, so the filter never triggers for
them; an explicit Feishu "reply/quote" to some other message still returns its id.

### 4. `/config` interactive card (parity with `requireMentionInGroup`)
- `src/card/config-card.ts`: add `replyInThreadInGroup: boolean` to `ConfigFormOpts`,
  a radio element (是/否) near the `requireMentionInGroup` control, and a summary line.
- `src/commands/index.ts`: populate the form opt from `getReplyInThreadInGroup(...)`,
  read the submitted radio value (yes/no → boolean, fall back to current value when
  absent), and persist it into preferences via the existing save path.

## Explicitly NOT changing

- **Session scoping** — `scope` stays `chatId` for regular groups (shared session per group).
- **Policy fingerprint** (`src/policy/fingerprint.ts`) — threading is presentation, not
  an access-control input, so it must not enter the fingerprint.
- topic-mode and p2p behavior.

## Edge cases & accepted limitations

- Streaming (`channel.stream`) accepts the same `sendOpts`, so threaded streaming
  works exactly as topic-mode does today.
- Accepted limitation (identical to topic mode today): if a user replies in-thread to
  the bot's *own* message (parent ≠ thread root), that message may still be fetched as
  a quote. Acceptable for v1; not worth special-casing.

## Testing

- **Unit (`tests/unit/config/`):** `getReplyInThreadInGroup` — default `true` when
  unset, `false` when `false`, `true` when `true`.
- **Unit (`tests/unit/bot/`):** `sendOpts` construction across the 4 contexts
  (p2p, regular+on, regular+off, topic) — assert `replyInThread` presence/absence.
- **Unit:** `replyQuoteTargetForMessage` — a regular-group in-thread message whose
  `replyTo === rootId` returns `undefined`; an explicit quote to another id returns it.
- Mirror existing test style in `tests/unit/bot/group.test.ts` and
  `tests/unit/config/profile-schema.test.ts`.
- Gate on `pnpm test && pnpm typecheck && pnpm build` (the `ci:platform` script).
