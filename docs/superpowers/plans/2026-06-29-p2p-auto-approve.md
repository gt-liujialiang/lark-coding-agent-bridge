# p2p Auto-Approve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In p2p chats, launch claude with `--permission-mode bypassPermissions` (default on, reversible via a preference) so claude never emits a per-tool permission prompt — eliminating the raw-TUI leak / silent stall observed in private chats.

**Architecture:** The permission mode is resolved once in `evaluateRunPolicy` (`src/policy/run-policy.ts`). We add two inputs to that function — the chat mode and the auto-approve toggle — and override the resolved mode to `bypassPermissions` when the run is p2p + claude + toggle-on. `startRunFlow` threads those two values from the channel call site, where the chat `mode` and `AppConfig` are already in scope. A new preference `claudeP2pAutoApprove` (default on) gates it.

**Tech Stack:** TypeScript, Vitest (`vitest run`), existing v2 profile/permission config.

**Scope note:** This plan covers **Part 1** of the design (`docs/superpowers/specs/2026-06-29-p2p-auto-approve-permission-card-design.md`). **Part 2** (rendering prompts as a card for groups/edges) is deferred to its own plan because its detector regex must be pinned to claude's *real* per-tool prompt format, captured via `CLAUDE_PTY_DEBUG_DIR` first. See the final section.

---

### Task 1: Add the `claudeP2pAutoApprove` preference + resolver

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/unit/config/claude-p2p-auto-approve.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config/claude-p2p-auto-approve.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { getClaudeP2pAutoApprove, type AppConfig } from '../../../src/config/schema.js';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 'x', tenant: 'feishu' } },
    preferences,
  };
}

describe('getClaudeP2pAutoApprove', () => {
  it('defaults to true when unset', () => {
    expect(getClaudeP2pAutoApprove(cfg(undefined))).toBe(true);
    expect(getClaudeP2pAutoApprove(cfg({}))).toBe(true);
  });

  it('returns true when explicitly true', () => {
    expect(getClaudeP2pAutoApprove(cfg({ claudeP2pAutoApprove: true }))).toBe(true);
  });

  it('returns false only when explicitly false', () => {
    expect(getClaudeP2pAutoApprove(cfg({ claudeP2pAutoApprove: false }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config/claude-p2p-auto-approve.test.ts`
Expected: FAIL — `getClaudeP2pAutoApprove` is not exported.

- [ ] **Step 3: Add the preference field**

In `src/config/schema.ts`, inside `interface AppPreferences`, add after `agentStopGraceMs?: number;`:

```typescript
  /**
   * In p2p (private) chats, launch claude in `bypassPermissions` so it never
   * emits a per-tool permission prompt — the owner is the only participant, so
   * per-tool approval is pure friction. Default `true`. Set `false` to fall
   * back to the access-tier-resolved permission mode in p2p as well. Groups /
   * topics are unaffected by this flag.
   */
  claudeP2pAutoApprove?: boolean;
```

- [ ] **Step 4: Add the resolver**

In `src/config/schema.ts`, add after `getAgentStopGraceMs`:

```typescript
/**
 * Resolve whether p2p chats auto-approve (run claude in bypassPermissions).
 * Default `true` — the `!== false` check makes older configs without the
 * field inherit the on-by-default behavior.
 */
export function getClaudeP2pAutoApprove(cfg: AppConfig): boolean {
  return cfg.preferences?.claudeP2pAutoApprove !== false;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/config/claude-p2p-auto-approve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/unit/config/claude-p2p-auto-approve.test.ts
git commit -m "feat(config): add claudeP2pAutoApprove preference (default on)"
```

---

### Task 2: Override permission mode to bypass for p2p claude runs

**Files:**
- Modify: `src/policy/run-policy.ts`
- Test: `tests/unit/policy/run-policy.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/policy/run-policy.test.ts`, add inside the `describe('run policy', ...)` block (after the existing access-mapping `it.each`):

```typescript
  it('forces bypassPermissions for p2p claude runs by default', () => {
    const result = evaluateRunPolicy(
      baseInput({
        chatMode: 'p2p',
        profileConfig: profile({
          permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.permissionMode).toBe('bypassPermissions');
  });

  it('does not force bypass in group chats', () => {
    const result = evaluateRunPolicy(
      baseInput({
        chatMode: 'group',
        profileConfig: profile({
          permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.permissionMode).toBe('acceptEdits');
  });

  it('does not force bypass when the p2p toggle is off', () => {
    const result = evaluateRunPolicy(
      baseInput({
        chatMode: 'p2p',
        claudeP2pAutoApprove: false,
        profileConfig: profile({
          permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.permissionMode).toBe('acceptEdits');
  });
```

> Note: `baseInput()` already supplies a claude capability (`claudeCapability(...)`),
> so `capability.agentId === 'claude'` holds in these tests without extra setup.
> If `baseInput`/`profile` do not yet accept the new `chatMode` /
> `claudeP2pAutoApprove` keys, they pass straight through `...overrides` into the
> `RunPolicyInput` spread — confirm the helper spreads overrides last (it does in
> the existing file).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/policy/run-policy.test.ts`
Expected: FAIL — `permissionMode` is `'acceptEdits'` for the p2p case (override not implemented), and TS errors on the unknown `chatMode` / `claudeP2pAutoApprove` input keys.

- [ ] **Step 3: Add the input fields**

In `src/policy/run-policy.ts`, inside `interface RunPolicyInput`, add after `ttlMs?: number;`:

```typescript
  /** Chat mode of the originating conversation. Used to scope p2p-only
   * permission behavior. Absent for non-chat callers (treated as non-p2p). */
  chatMode?: 'p2p' | 'group' | 'topic';
  /** When not `false`, p2p claude runs are forced to `bypassPermissions`
   * (the `claudeP2pAutoApprove` preference). Defaults to on. */
  claudeP2pAutoApprove?: boolean;
```

- [ ] **Step 4: Apply the override**

In `src/policy/run-policy.ts`, change the `permissionMode` assignment in `evaluateRunPolicy` from:

```typescript
  const permissionMode = accessToClaudePermissionMode(
    accessMode,
    input.profileConfig.permissions,
  );
```

to:

```typescript
  let permissionMode = accessToClaudePermissionMode(
    accessMode,
    input.profileConfig.permissions,
  );
  // p2p auto-approve: a private chat is just the owner, so per-tool prompts are
  // pure friction. Force claude into bypassPermissions there (default on).
  // Groups/topics keep the tier-resolved mode. Codex has no permissionMode
  // concept, so this is gated on the claude capability.
  if (
    input.capability.agentId === 'claude' &&
    input.chatMode === 'p2p' &&
    input.claudeP2pAutoApprove !== false
  ) {
    permissionMode = 'bypassPermissions';
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/policy/run-policy.test.ts`
Expected: PASS (existing tests + 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/policy/run-policy.ts tests/unit/policy/run-policy.test.ts
git commit -m "feat(policy): force bypassPermissions for p2p claude runs"
```

---

### Task 3: Thread chatMode + toggle from the channel call site

**Files:**
- Modify: `src/bot/run-flow.ts`
- Modify: `src/bot/channel.ts`

- [ ] **Step 1: Add the fields to `StartRunFlowInput`**

In `src/bot/run-flow.ts`, inside `interface StartRunFlowInput`, add after `now: number;`:

```typescript
  chatMode?: 'p2p' | 'group' | 'topic';
  claudeP2pAutoApprove?: boolean;
```

- [ ] **Step 2: Forward them into `evaluateRunPolicy`**

In `src/bot/run-flow.ts`, in the `evaluateRunPolicy({ ... })` call, add after `inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,`:

```typescript
    chatMode: input.chatMode,
    claudeP2pAutoApprove: input.claudeP2pAutoApprove,
```

- [ ] **Step 3: Import the resolver in channel.ts**

In `src/bot/channel.ts`, add `getClaudeP2pAutoApprove` to the existing import block from `../config/schema` (the block that already imports `getMessageReplyMode`, `getToolCallDisplay`, etc.):

```typescript
  getClaudeP2pAutoApprove,
```

- [ ] **Step 4: Pass the values at the call site**

In `src/bot/channel.ts`, in the `startRunFlow({ ... })` call (~line 700), add after `now: Date.now(),`:

```typescript
    chatMode: mode,
    claudeP2pAutoApprove: getClaudeP2pAutoApprove(controls.cfg),
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0 (no errors).

- [ ] **Step 6: Run the unit suite**

Run: `pnpm test:unit`
Expected: all pass (including Task 1 + Task 2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/bot/run-flow.ts src/bot/channel.ts
git commit -m "feat(bot): wire p2p auto-approve into run dispatch"
```

---

### Task 4: Verify end-to-end behavior expectation (manual checklist)

**Files:** none (verification only)

- [ ] **Step 1: Confirm the resolution path**

Re-read `src/bot/channel.ts` around the `startRunFlow` call: `mode` is the
`chatModeCache.resolve(...)` value (`'p2p' | 'group' | 'topic'`) and
`controls.cfg` is the `AppConfig`. Confirm both are in scope at the call site
(they are — `mode` is used at `isGroupChat = mode !== 'p2p'`, and `controls.cfg`
at `getMessageReplyMode(controls.cfg)`).

- [ ] **Step 2: Confirm adapter launch**

Re-read `src/agent/claude/adapter.ts:180` — claude is launched with
`'--permission-mode', permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE`. The
`permissionMode` originates from `policy.permissionMode`, which Task 2 now sets
to `bypassPermissions` for p2p. No further wiring needed.

- [ ] **Step 3: Note the runtime caveat**

The running bot must be rebuilt + restarted to pick up this change; it only
takes effect on new runs. Record this in the PR / handoff notes.

---

## Part 2 (deferred): permission prompts as a card

Part 2 of the design (groups/edges → clean card instead of raw TUI) is **not**
in this plan. Its detector regex and button→keystroke mapping must match
claude's real per-tool prompt format, which we have not captured.

**First action when starting Part 2:**

1. On the deployed bot, set `CLAUDE_PTY_DEBUG_DIR=/tmp/claude-pty-debug`.
2. In a **group** chat (where bypass is not forced), send a prompt that makes
   claude run a Bash command so its native permission prompt renders.
3. Grab the raw buffer from `/tmp/claude-pty-debug/<sessionId>.pty`, run it
   through `stripAnsi`, and record the exact prompt text + numbered option order.
4. Re-invoke `superpowers:writing-plans` to author the Part 2 plan with the
   regex and keystroke mapping pinned to that captured buffer.
