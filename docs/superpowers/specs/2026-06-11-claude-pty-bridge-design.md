# Claude PTY Bridge — Design

Date: 2026-06-11
Status: Approved for implementation
Scope: `lark-coding-agent-bridge` Claude adapter only

## Motivation

`claude -p <prompt> --output-format stream-json` is no longer supported by the
upstream `claude` CLI. The current bridge `ClaudeAdapter`
(`src/agent/claude/adapter.ts`) drives Claude exactly that way — one fresh
process per turn, parsing stream-json from stdout — so it is broken end-to-end
once that mode disappears.

The sibling demo `seed-offline-tasks` already proved a working alternative:
keep a long-lived `claude` TUI under a PTY, type prompts in, and tail the
session JSONL log (`~/.claude/projects/<encoded(cwd)>/<sessionId>.jsonl`) for
output. This spec ports that pattern into the bridge while preserving the
bridge's per-chat concurrency, multi-session lifecycle, and existing
`AgentAdapter` / `AgentRun` contract.

## Goals

- Replace `claude -p` with a persistent PTY driven via `node-pty`, with JSONL
  log polling as the primary output channel.
- Match the bridge's per-Lark-session concurrency: one PTY per
  `claudeSessionId`, reused across turns in the same Lark conversation.
- Keep the existing `AgentAdapter`, `AgentRun`, and `AgentEvent` interfaces
  intact so consumers (`bot/channel.ts`, `runtime/run-executor.ts`,
  `card/templates.ts`, etc.) are unchanged.
- Preserve the existing slash-command flows (`/new`, `/reset`, `/cd`,
  `/resume`, `/stop`) with the same observable behavior.

## Non-goals

- Codex adapter is untouched.
- Windows support is intentionally dropped for the Claude path. `node-pty`
  ConPTY plus the seed approach is unproven on Windows for this codebase, and
  the demo project is explicitly macOS-only. README and CI matrix are updated
  to reflect that.
- No feature flag / parallel old adapter — full replacement. The old
  stream-json adapter is removed.
- No attempt to auto-allow tool calls beyond the one-time Bypass Permissions
  startup screen. The bridge's default permission mode (`bypassPermissions`)
  already disables per-tool prompts.

## Decisions captured during brainstorming

| Decision | Value |
|----------|-------|
| Scope | Replace `ClaudeAdapter` only; Codex unchanged |
| Platforms | macOS + Linux; Windows removed |
| PTY pooling | One PTY per `claudeSessionId`, reused across turns |
| Stop semantics | Soft interrupt (ESC) on `/stop`; hard close on `/new`, `/cd`, `/reset` |

## Architecture

```
ClaudeAdapter (singleton, owned by bridge)
├── id = 'claude'
├── setBotIdentity(identity)             — bot open_id baked into system prompt
├── run(opts) → AgentRun
└── closeSession(claudeSessionId)        — NEW; called from /new, /cd, /reset

ClaudePtyPool
├── sessions: Map<claudeSessionId, PtySession>
├── acquire({ sessionId?, cwd, model, permissionMode, identity })
│       ├─ HIT  → return existing PtySession
│       └─ MISS → spawn PtySession (--session-id new | --resume id)
├── release(sessionId)                   — explicit close
└── idleReaper                           — closes PTYs idle > 30 min (configurable)

PtySession (one long-lived `claude` TUI)
├── pty (node-pty.IPty)
├── cwd, claudeSessionId, jsonlPath, lineCursor
├── runTurn(prompt) → AsyncIterable<AgentEvent>
├── softInterrupt()                      — write ESC; PTY stays alive
└── hardClose()                          — SIGTERM → grace → SIGKILL
```

## Process model per turn

```
bridge.run-flow → ClaudeAdapter.run(opts)
  │
  └─ pool.acquire(opts.sessionId?, opts.cwd, ...)
        ├─ HIT  : reuse existing PtySession
        └─ MISS : spawn new claude via node-pty with:
                    --permission-mode <mode>
                    --session-id <newUuid>  |  --resume <existingId>
                    --append-system-prompt "<bridge system prompt>"
                    --model <model>  (if set)
                  env = mergedEnv (lark-channel-env + process.env)
                  cwd = opts.cwd
                  wait for startup readiness; auto-accept "I accept" if shown
  │
  └─ PtySession.runTurn(opts.prompt)
        1. turnStart = countJsonlLines(jsonlPath)
        2. resetScreenBuffer()
        3. write prompt → sleep 200ms → write "\r"   (separate writes; required)
        4. loop poll @ 300ms:
             read new JSONL entries past lineCursor → translate → yield events
             rolling PTY buffer substring-match "I accept" → write "2\r" once
             if stop_reason="end_turn" → yield 'usage' + 'done'(normal); break
             if PTY exits → yield 'error'(failed); evict from pool
             if MAX_TURN_DURATION exceeded → softInterrupt; yield 'error'(timeout)
        5. return
  │
  └─ AgentRun consumed as today by run-executor + card streaming
```

## Lifecycle hooks

| Trigger | Bridge action | Adapter action |
|---------|---------------|----------------|
| New message in known session | `run({ sessionId })` | pool HIT → reuse PTY |
| First message in a fresh session | `run({ sessionId: undefined })` | pool MISS → spawn `--session-id newUuid`; emit `system { sessionId }` so bridge persists it |
| `/new` or `/reset` | clear stored sessionId, then `adapter.closeSession(prevId)` | hardClose, evict |
| `/cd <path>` | same as `/new` (cwd change ⇒ new PTY) | hardClose, evict |
| `/resume` | bridge looks up compatible session, passes its id | pool MISS → spawn `--resume <id>` |
| `/stop` (chat or card button) | `run.stop()` | softInterrupt; PTY stays alive |

## Event translation

JSONL entries closely mirror the previous stream-json schema. The translator
moves from `src/agent/claude/stream-json.ts` to
`src/agent/claude/jsonl-translate.ts` with these adjustments:

- Drop the `type:'result'` branch — the JSONL log has no top-level result line.
- Synthesize `usage` + `done` when an assistant entry's
  `message.stop_reason === 'end_turn'` lands. `usage` is summed across all
  assistant entries from `turnStart` (input + cache_creation + cache_read for
  inputTokens; output for outputTokens).
- `type:'system'` init event is synthesized once when the PTY first spawns and
  the JSONL file appears (carries the assigned `sessionId` so the bridge can
  store it).
- `assistant.content[]` blocks (`text`, `thinking`, `tool_use`) → existing
  `text`, `thinking`, `tool_use` events — unchanged.
- `user.content[]` `tool_result` blocks → existing `tool_result` events —
  unchanged.

## Error mapping

| Condition | Emitted event | Pool effect |
|-----------|--------------|-------------|
| `node-pty` fork fails (e.g. binary missing) | `error { terminationReason: 'failed' }` | nothing added |
| `claude` exits mid-turn | `error { terminationReason: 'failed' }` | evict |
| Turn exceeds `MAX_TURN_DURATION` (default 10min) | softInterrupt then `error { terminationReason: 'timeout' }` | keep |
| User `/stop` (soft interrupt completed) | `done { terminationReason: 'interrupted' }` | keep |
| `closeSession` from `/new` / `/cd` | (no event — bridge initiated) | evict |

## Permission auto-allow scope

Minimal. The adapter only handles the one-time `"Bypass Permissions mode"`
startup screen by substring-matching `"I accept"` in a rolling PTY buffer
(~2 KB) and sending `2\r` once. Per-tool permission prompts are not handled —
`--permission-mode bypassPermissions` (the bridge default for `permissions.full`)
disables them. `acceptEdits` and `plan` modes don't pause for input the bridge
could meaningfully forward.

No `vt10x`-style terminal emulator dependency; raw substring matching is
sufficient.

## Files

| File | Change |
|------|--------|
| `src/agent/claude/adapter.ts` | REWRITE — owns `ClaudePtyPool`; `run()` returns an `AgentRun` proxying `PtySession.runTurn` |
| `src/agent/claude/pty-session.ts` | NEW — spawns claude under `node-pty`, drives one turn |
| `src/agent/claude/pty-pool.ts` | NEW — sessionId → PtySession map, idle reaper |
| `src/agent/claude/jsonl-reader.ts` | NEW — incremental JSONL tail (lineCursor + 16 MB buffer) |
| `src/agent/claude/jsonl-translate.ts` | NEW — JSONL entry → `AgentEvent`, supersedes `stream-json.ts` |
| `src/agent/claude/stream-json.ts` | DELETE |
| `src/agent/types.ts` | PATCH — add optional `closeSession(sessionId)` on `AgentAdapter` (no-op for Codex) |
| `src/agent/preflight.ts` | PATCH — keep `claude --version` check; drop any `-p`-specific probing |
| `src/bot/channel.ts` | PATCH — wire `closeSession` into the `/new`, `/cd`, `/reset`, `/resume` paths |
| `src/commands/*` | PATCH — small hook calls to `adapter.closeSession?(prevId)` where the session is reset |
| `src/cli/commands/start.ts` | NO CHANGE — already constructs `ClaudeAdapter` and sets identity |
| `package.json` | PATCH — add `node-pty` dep; document Windows regression |
| `tests/agent/claude/*` | REWRITE — see test plan |
| `tests/fixtures/claude-fake/claude.sh` | NEW — scriptable fake claude that writes JSONL + prints TUI markers |
| `.github/workflows/*` | PATCH — drop `windows-latest` from the matrix |
| `README.md` / `README.zh.md` | PATCH — call out macOS/Linux only, native dep |

## Testing strategy

### Fake claude fixture

A POSIX shell script at `tests/fixtures/claude-fake/claude.sh` that:

- Parses `--session-id`, `--resume`, `--permission-mode`,
  `--append-system-prompt`, `--model`.
- Prints a configurable startup screen (optionally including
  `"Yes, I accept"` to exercise the auto-accept path).
- Reads stdin line-by-line; for each prompt, appends a scripted JSONL sequence
  (assistant text → tool_use → tool_result → assistant text with
  `stop_reason: end_turn`) to
  `~/.claude/projects/<encoded(cwd)>/<sessionId>.jsonl`.
- Honors `FAKE_CLAUDE_MODE` env (`hang`, `crash`, `slow`) for failure tests.

Tests pass `binary` pointing at this script — same pattern the current claude
tests use.

### Unit

- `jsonl-reader`: incremental tail on a growing fixture; lineCursor
  accounting; partial-line handling; 16 MB max line.
- `jsonl-translate`: ports the existing `stream-json` translator tests; adds
  `end_turn → usage+done` synthesis, thinking blocks, tool_result with error.
- `pty-pool`: acquire / release / idle eviction with a stubbed `PtySession`.

### Integration (`pty-session`)

- Happy path: spawn fake claude, drive three turns, verify events per turn and
  no process restarts between turns.
- Resume: spawn with `--resume <id>`; `lineCursor` starts at the file's
  existing length, not 0.
- Soft interrupt: long turn, `stop()`, expect `done(interrupted)` within
  grace; PTY still alive; next turn succeeds.
- Hard close: `closeSession()` after a turn; pool no longer holds the entry;
  next `run()` with the same sessionId triggers `--resume` respawn.
- PTY death mid-turn: `error(failed)` emitted; pool eviction observable.
- Auto-accept: fake claude prints `"I accept"` on startup; assert `2\r` is
  written before any prompt is sent.

### CI

`.github/workflows/*` drop `windows-latest` from the Claude path. Linux +
macOS only. Codex tests keep their existing matrix.

### Manual smoke before merge

A full conversation with `/new`, three follow-ups, `/cd <other dir>`, `/stop`
mid-turn, `/resume`. Verify card streaming still updates at the same rate as
today; the 300 ms JSONL poll interval keeps update cadence well under 1 s.

## Rollout

- Single PR, no feature flag.
- Bump minor. Release notes call out:
  - Windows is no longer supported on the Claude path (Codex path unchanged).
  - New `node-pty` native dep — `pnpm install` will compile it on first run.
  - Claude logs are now persistent under `~/.claude/projects/...` (this was
    already true for users who ran `claude` interactively, but is now also
    true for bridge-only users).
- Codex adapter untouched.

## Open risks

- **`node-pty` native build.** Mitigation: pin to a version with prebuilt
  binaries for the supported platforms; document the build-tool requirement
  for systems that have to fall back to source build.
- **`~/.claude/projects/` path stability.** Claude could change the on-disk
  layout. Mitigation: the path derivation is isolated in `pty-session.ts`;
  swap is one place if Claude renames the convention.
- **Auto-accept failing under future Claude TUI redesigns.** Mitigation: the
  trigger string is in one place; can be extended with additional patterns if
  needed.
- **Permission auto-allow for `acceptEdits` / `plan` paths.** Out of scope
  here; if a future Claude update starts prompting interactively in those
  modes, the turn would hang until the watchdog fires. Acceptable; followup
  spec if it materializes.
