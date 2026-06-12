# Claude Session Handoff — Design

Date: 2026-06-12
Status: Approved for implementation
Scope: `lark-coding-agent-bridge` Claude adapter; macOS/Linux only.

## Motivation

A user often starts a Claude session in their local terminal (e.g. running
`claude` in some project directory), works on it for a while, then needs to
step away from the desk but wants to keep the conversation going on their
phone via the Lark bridge.

Today this is technically possible — bridge already supports `/resume`, and
both terminal `claude` and bridge write to the same
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` log — but the manual
flow is awkward:

1. Note the cwd of the terminal session.
2. `/exit` the terminal claude.
3. In the bridge p2p chat, `/cd <that cwd>`.
4. `/resume`, pick the right session from the card.

Step 1 requires the user to remember/copy a path; step 3 + 4 require typing
slash commands on the phone keyboard. We want this to be a single command run
on the terminal — bridge does the rest.

## Goals

- Single-command terminal flow: `lark-channel-bridge handoff` parks the most
  recent local Claude session into the owner's Lark p2p chat with the bot.
- After handoff, the next message the owner sends in that p2p chat resumes
  the terminal session — bridge spawns `claude --resume <id>` with the
  adopted session id.
- A non-interactive notification card lands in the p2p showing project,
  session id, topic preview, line count, and time — so the owner knows what
  was just adopted.
- Reuse existing bridge mechanics: session catalog, PTY pool, `/resume`
  switching logic.

## Non-goals

- **Bidirectional**: bridge → terminal handoff is out of scope. Local
  `claude --resume <id>` already covers it.
- **Codex**: Codex thread/branch model differs from Claude jsonl; not in this
  spec.
- **Windows**: bridge already dropped Windows for the Claude path (0.4.0+).
  Handoff inherits that. CLI exits with a clear message on `win32`.
- **Recipients other than profile owner**: no `--to <user>` flag. YAGNI.
- **Auto-trigger on claude exit (hooks)**: out of scope. Explicit CLI only.
- **PTY conflict detection / `--force`**: by convention the user `/exit`s
  the terminal claude before invoking `handoff`. Documented in README; not
  enforced in code.

## User-facing flow

```bash
# In the terminal where you ran claude
cd ~/github/foo
claude
# ... work for a while ...
/exit                       # convention: exit first

lark-channel-bridge handoff
# → 已推送会话 abc12345... 到飞书私聊
```

Phone / Lark:

```
🔗 已接管终端 Claude 会话
项目        /Users/gaotu/github/foo
Session ID  abc12345-6789-4def-...
主题        把 user_id 字段加到 audit log
47 条对话 · 刚刚
直接发消息继续 · 回 /resume 可切回旧会话
```

User sends next message in that p2p → bridge spawns
`claude --resume abc12345-...` against `/Users/gaotu/github/foo`, conversation
continues from where the terminal left off.

## CLI interface

```bash
lark-channel-bridge handoff                  # latest jsonl in cwd
lark-channel-bridge handoff --session <id>   # explicit
lark-channel-bridge handoff --list           # numbered chooser
lark-channel-bridge handoff --cwd <path>     # default: process.cwd()
lark-channel-bridge handoff --profile <name> # default: active profile
```

`--session` and `--list` are mutually exclusive (commander conflict).

Exit codes:

- `0` — card sent; session adopted by bridge.
- `1` — generic error (jsonl not found, bridge not running, send failure).
- `2` — argument error.

On `process.platform === 'win32'`, the command exits `1` with:

```
handoff is not supported on Windows. Use claude --resume <id> locally instead.
```

## Architecture

### Components

1. **`src/cli/commands/handoff.ts`** (new) — commander subcommand.
   - Resolves cwd, profile, sessionId (auto or explicit).
   - Reads jsonl directory, picks/lists candidates.
   - Connects to bridge control socket, sends request, prints result.

2. **`src/runtime/control-socket.ts`** (new) — Unix domain socket server
   running inside the bridge process.
   - Listens on `<profileDir>/control.sock`, mode `0600`.
   - Line-delimited JSON protocol (one request → one response → close).
   - Dispatches by `op` field. Initially supports `handoff`; built to allow
     adding `status`, `whois`, etc. later.

3. **`src/runtime/handoff-handler.ts`** (new) — bridge-side handler for the
   `handoff` op.
   - Resolves owner p2p scope.
   - Interrupts active run on that scope.
   - Closes previous PTY iff different sessionId.
   - Updates `sessionCatalog` and `sessions` store.
   - Builds notification card and sends via `channel`.

4. **`src/agent/claude/jsonl-scan.ts`** (new) — pure helpers.
   - `pickLatest(cwd, home)` → `{sessionId, mtime, lineCount} | null`
   - `listCandidates(cwd, home, n)` → array of same
   - `readPreview(jsonlPath)` → `{firstUserMessage, lineCount}`
   - All take an injectable `fs` so tests can run on tmpfs.

5. **`src/card/handoff-card.ts`** (new) — CardKit 2.0 builder. Pure function,
   no IO.

### Existing code reused

- `src/agent/claude/jsonl-path.ts` — `encodeCwdForClaudeProjects(cwd)`.
- `src/session/preview.ts` — first-user-message extraction (already used by
  `/resume`).
- `src/session/store.ts` — `sessions.set(scope, sessionId, cwd)`.
- `src/session/catalog.ts` — `sessionCatalog.upsertActive(...)`.
- `src/agent/claude/pty-pool.ts` — `agent.closeSession(prevId)` to release
  the prior PTY.
- `src/bot/channel.ts` — `channel.send(chatId, { card })`.

### Control-socket startup

`bot/channel.ts` (or wherever the bridge lifecycle is owned) starts the
socket server on bridge start, alongside the existing channel listener.
The socket is cleaned up on graceful shutdown (`SIGTERM`/`SIGINT`).

Stale socket files from a previous crash are unlinked on startup before
`server.listen()`.

## Wire protocol

Request (one line of JSON):

```json
{"op":"handoff","cwd":"/Users/gaotu/github/foo","sessionId":"abc12345-..."}
```

Response (one line of JSON, then connection close):

```json
{"ok":true,"sessionIdShort":"abc12345","scopeId":"p2p:oc_xxx","lineCount":47,"preview":"把 user_id 字段加到 audit log"}
```

Or:

```json
{"ok":false,"error":"session-not-found","detail":"no jsonl matching abc12345 under <encoded cwd>"}
```

Error codes:

- `session-not-found` — jsonl file does not exist for that session id / cwd.
- `owner-chat-unreachable` — owner p2p doesn't exist and create_p2p_chat
  failed (rare; usually means owner never DM'd the bot before).
- `bridge-internal` — uncaught error; see bridge logs.

Connection errors (ECONNREFUSED / ENOENT on the socket) are surfaced by the
CLI as `bridge not running`.

## Bridge-side handoff steps

Given a validated `{cwd, sessionId}`:

1. Resolve target scope:
   - Read profile `owner.openId` (already in config).
   - Look up existing p2p scope for that owner in `sessions.json`.
   - Fallback: send via Lark IM by user_id (the SDK accepts user_id as a
     send target and resolves it to a p2p chat).
2. `activeRuns.interrupt(scope)` — same as `/resume`.
3. `agent.closeSession(prevSessionId)` — only if `prevSessionId &&
   prevSessionId !== sessionId`.
4. `sessionCatalog.upsertActive({scopeId, agentId:'claude', cwdRealpath:
   cwd, policyFingerprint: currentProfilePolicy, sessionId})`.
5. `sessions.set(scope, sessionId, cwd)`.
6. Read jsonl metadata (line count, first user message, mtime) using
   `jsonl-scan.readPreview`.
7. Build notification card via `handoff-card.build({cwd, sessionId,
   preview, lineCount, mtime})`.
8. `channel.send(chatId, {card})`.
9. Respond `{ok:true, ...}` on the socket.

The order ensures that even if the user sends a message between steps 4 and
7, the next bridge run for that scope already uses the adopted session id
(catalog + sessions store updated before send).

## Card format

CardKit 2.0 (`schema: "2.0"`). Pure display: no buttons, no callback tokens.

Visual structure:

- **Header**: 🔗 已接管终端 Claude 会话
- **Body** (two-column layout):
  - Left:
    - **项目** — full cwd, monospace
    - **Session ID** — full UUID, monospace, copyable if CardKit supports
  - Right:
    - **主题** — first user-message preview (60 chars, ellipsized)
    - **对话** — `{lineCount} 条 · {relTime}`
- **Footer note** (plain text): `直接发消息继续 · 回 /resume 可切回旧会话`

Exact element tags resolve at implementation time against CardKit 2.0 spec.
See existing `src/card/templates.ts` and `src/card/run-renderer.ts` for the
conventions already in use in this codebase.

## Failure modes

| Situation | Handling |
|---|---|
| jsonl for sessionId missing | socket `{ok:false, error:"session-not-found"}`; CLI exits 1 with message |
| owner p2p missing AND create fails | socket `{ok:false, error:"owner-chat-unreachable"}` |
| Same sessionId already active for scope | no-op for PTY/catalog; still sends a card so owner knows |
| bridge not running | CLI catches connect error, prints `bridge not running. start it with 'lark-channel-bridge start [--profile <name>]'`, exits 1 |
| Terminal claude still writing jsonl | not detected; documented requirement. Dual-write to same jsonl may corrupt later turns. |
| Windows | CLI exits 1 with platform message; never opens socket |
| Multiple profiles, wrong one targeted | `--profile` selects which control.sock to connect to; default = active profile |

## Security

- Socket lives in user-private dir (`~/.lark-channel/profiles/<profile>/`)
  with `0600` mode. Only the same OS user can connect.
- No auth token on socket protocol — POSIX permissions are sufficient for
  same-user local IPC.
- Handoff causes a session-id switch for the owner's p2p scope. The owner
  can always `/resume` back to whatever was active before. Old sessions
  are not deleted.

## Testing

Unit tests only (`tests/unit/handoff/`). Manual smoke for integration.

1. `scan-jsonl.test.ts`
   - `pickLatest()` with mocked fs and known mtimes.
   - `listCandidates(n)` ordering and limit.
   - Empty dir / missing dir → empty array, no throw.

2. `extract-preview.test.ts`
   - First user message extracted from fixture jsonl.
   - 60-char truncation.
   - Line count.
   - Malformed lines skipped.

3. `socket-protocol.test.ts`
   - Spin up a server on a tmp socket path.
   - Round-trip `handoff` request/response.
   - Error response shape.
   - Client gracefully handles ECONNREFUSED.

4. `cli-args.test.ts`
   - Argument parsing happy paths.
   - `--session` and `--list` mutual exclusion error.

5. `handoff-handler.test.ts`
   - Mock `sessionCatalog`, `agent.closeSession`, `channel.send`.
   - Assert call order: interrupt → closeSession (if id changed) → upsert
     → sessions.set → channel.send.
   - Same sessionId: `closeSession` NOT called.
   - jsonl missing: returns `{ok:false}` before any state mutation.

Out of scope: real Lark API integration tests, Windows path tests, multi-
profile concurrent handoff.

Manual smoke script lives in README's new "Session handoff" section.

## Documentation

- README (Chinese + English): new "终端会话接管 / Session handoff" section
  after "Claude 会话的持久化方式". Covers the smoke flow and the requirement
  to `/exit` terminal claude first.
- `lark-channel-bridge handoff --help` produced by commander reflects the
  flags above.

## Migration / rollout

- No config schema change.
- No behavior change for existing users until they explicitly run `handoff`.
- The control socket is started unconditionally on bridge boot; if the
  socket fails to bind (e.g. permission issue), bridge logs a warning and
  keeps running — handoff just won't be available that session.

## Open questions

None as of this revision.
