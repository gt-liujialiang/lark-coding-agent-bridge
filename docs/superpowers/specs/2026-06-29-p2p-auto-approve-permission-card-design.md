# p2p auto-approve + permission-prompt card — design

Date: 2026-06-29
Status: approved (pending spec review)
Branch: feat/claude-pty-bridge

## Problem

The bridge drives a real `claude` CLI in a PTY. Claude is launched with
`--permission-mode <mode>`, where `<mode>` is resolved from the scope's access
tier (`config/permissions.ts`):

- `full` → `bypassPermissions` (no per-tool prompts)
- `workspace` → `acceptEdits` (auto-accepts edits, **still prompts for Bash**)
- `read-only` → `plan`

When a run resolves to `acceptEdits`/`default`, claude renders its **native TUI
permission prompt** ("Permission Request / Agent wants to use Bash: … / Allow /
Deny / Allow All") before running a Bash command. The bridge only auto-handles
**startup** consent dialogs (`CONSENT_DIALOGS` in `agent/claude/pty-session.ts`)
— it has **no handler for per-tool permission prompts**. As a result:

1. Claude's raw TUI screen leaks into the Lark chat verbatim (English text, the
   command shown twice), and
2. the turn silently stalls waiting on input that never comes from a Lark user.

Observed in a p2p chat where the user expected the bot to "just run it" (an
earlier session had resolved to `bypassPermissions` and auto-approved cleanly).

## Goals

- **p2p: always auto-approve.** A private chat is just the owner talking to the
  bot; per-tool prompts are pure friction there.
- **Never leak raw TUI.** Any permission prompt that does surface (groups, or an
  unexpected edge) must render as a clean Lark card with working buttons, not a
  raw screen dump, and must never silently stall the turn.

## Non-goals

- Changing the access-tier model for groups/topics. Groups keep the resolved
  tier behavior — only the *presentation* of a prompt changes (card vs raw TUI).
- Codex permission/sandbox behavior. This is claude-PTY specific.
- Any change to who is *allowed* to invoke the bot (access lists are unchanged).

## Design

### Part 1 — p2p always bypasses

When the run scope is `p2p`, claude launches with
`--permission-mode bypassPermissions` regardless of the resolved access tier, so
claude never emits a per-tool prompt. Auto-approve by construction; no
screen-scraping involved. The startup "Bypass Permissions mode" warning is
already auto-accepted by the existing `bypass-permissions` entry in
`CONSENT_DIALOGS`.

- **Toggle:** a preference `claudeP2pAutoApprove`, default **on**, so the
  behavior is reversible without a code change. When off, p2p falls back to the
  normal tier-resolved mode (and Part 2 handles any prompt).
- **Injection point:** where the resolved `permissionMode` is passed to the
  claude adapter run options (run-flow / channel). If `mode === 'p2p'` and the
  toggle is on, force `bypassPermissions`; group/topic resolution is unchanged.
- **Scope check:** the override keys off the chat `mode` already known at run
  dispatch (`'p2p' | 'group' | 'topic'`), not off access tier.

### Part 2 — permission prompts render as a card (groups + edges)

For runs **not** covered by Part 1 (groups/topics, or p2p with the toggle off),
a per-tool permission prompt must become a card instead of leaking.

- **Detector:** extend the `handleData` matcher in `pty-session.ts` with a
  pattern for claude's per-tool permission prompt — its known
  `Do you want to proceed? / 1. Yes / 2. Yes, and don't ask again / 3. No`
  shape — matched on the ANSI-stripped rolling buffer, the same way
  `CONSENT_DIALOGS` patterns are matched.
- **Surface:** on match, emit a structured event reusing the existing
  `ask_user_question` event shape (so no new event plumbing is needed). The bot
  renders a clean Lark card with **Allow** / **Allow All (this session)** /
  **Deny** buttons.
- **Route back:** a button click writes the matching keystroke (`1\r` / `2\r` /
  `3\r`) to the PTY through the **existing** AskUserQuestion card→PTY keystroke
  machinery (the `answerQuestion` / one-key-at-a-time write path). No new PTY
  write path.
- **Last-resort net:** if the PTY is clearly blocked on a prompt but the buffer
  matches no known pattern, surface the stripped tail as a card asking the user
  to reply `allow` / `deny`, instead of silently stalling. This guarantees the
  "raw TUI dump + silent stall" failure mode cannot recur.

## Components touched

- `src/config/schema.ts` — add `claudeP2pAutoApprove` preference (default on) +
  a `getClaudeP2pAutoApprove(cfg)` resolver.
- run dispatch (`src/bot/run-flow.ts` / `src/bot/channel.ts`) — apply the p2p
  bypass override to the adapter run options.
- `src/agent/claude/pty-session.ts` — per-tool permission prompt detector;
  emit the structured ask event; last-resort blocked-prompt surfacing.
- card rendering / dispatch — a permission card (can reuse / extend the
  AskUserQuestion card) and its button→keystroke callback routing.

## Data flow

```
run dispatch
  └─ mode === 'p2p' && claudeP2pAutoApprove
       ├─ yes → permissionMode = bypassPermissions → claude never prompts
       └─ no  → tier-resolved permissionMode
                   └─ claude TUI prompt → pty-session detector
                        ├─ matched → ask_user_question event → Lark card
                        │              └─ button click → keystroke → PTY
                        └─ unmatched & blocked → tail card → reply allow/deny
```

## Error handling

- Toggle off + group: prompt always becomes a card; if the card callback can't
  be signed (no `callbackAuth`), fall back to the reply-`allow/deny` text path.
- Keystroke write after PTY exit: no-op (session already dead); the turn ends
  via the normal exit path.
- Pattern false-positive: matching only fires while the PTY is awaiting input
  (quiet buffer ending in the prompt), reducing the chance of matching prompt
  text echoed inside tool output.

## Testing

- **Part 1:** unit test that `p2p` resolves to `bypassPermissions` with the
  toggle on; that `group`/`topic` keep the tier-resolved mode; that the toggle
  off restores tier resolution. Resolver default test (`claudeP2pAutoApprove`
  defaults on).
- **Part 2:** unit test the per-tool prompt detector against sample
  ANSI-stripped buffers (match / no-match, including the prompt text appearing
  inside tool output → no match). Unit test the button→keystroke mapping
  (Allow→`1\r`, Allow-All→`2\r`, Deny→`3\r`). Test the last-resort path emits a
  card rather than stalling.

## Open risk — verify the real prompt format first

The Part 2 detector pattern and the button→keystroke mapping depend on claude's
**exact** per-tool permission prompt text and option order. We currently only
have the user's paraphrase ("Allow / Deny / Allow All"), which may differ from
the numeric `1./2./3.` TUI format. **First implementation step for Part 2:**
capture a real per-tool prompt via `CLAUDE_PTY_DEBUG_DIR` against the deployed
claude version and pin the regex + keystroke mapping to that captured buffer.
Part 1 does not depend on this (it removes the prompt entirely in p2p).

## Build order

1. Part 1 (small; fully resolves the reported p2p bug; no dependency on the
   unverified prompt format).
2. Part 2 (larger; the group/edge safety net; starts by capturing the real
   prompt format).
