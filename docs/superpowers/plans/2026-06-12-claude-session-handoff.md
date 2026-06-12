# Claude Session Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lark-channel-bridge handoff` CLI command that parks a local terminal Claude session into the owner's Lark p2p chat, so the user can continue the conversation on their phone via the bridge.

**Architecture:** CLI client opens a per-profile Unix-domain control socket (`<profileDir>/control.sock`) on the running bridge daemon; bridge mutates session catalog + sessions store to adopt the terminal jsonl session id for the owner's p2p scope, sends a CardKit 2.0 notification card, and the next Lark message resumes the conversation via `claude --resume <id>`.

**Tech Stack:** TypeScript, Node.js >= 20.12, commander, node-pty (existing), vitest. macOS/Linux only (Windows exits with platform message).

**Spec:** [`docs/superpowers/specs/2026-06-12-claude-handoff-design.md`](../specs/2026-06-12-claude-handoff-design.md)

---

## File map

| File | Role |
|---|---|
| `src/agent/claude/jsonl-scan.ts` (new) | Pure helpers: list / pick / preview claude jsonl files under an encoded-cwd dir |
| `src/card/handoff-card.ts` (new) | Pure CardKit 2.0 builder for the "session adopted" notification card |
| `src/runtime/control-protocol.ts` (new) | Pure wire-protocol types + encode/decode helpers for the control socket |
| `src/runtime/control-socket.ts` (new) | `node:net` server lifecycle — listens on per-profile socket, dispatches to handlers |
| `src/runtime/handoff-handler.ts` (new) | Bridge-side handoff logic: resolve owner scope, mutate catalog/sessions, build card, send |
| `src/cli/commands/handoff.ts` (new) | Commander subcommand: parse args, talk to control socket, print result |
| `src/cli/index.ts` (modify) | Register `handoff` command |
| `src/bot/channel.ts` (modify) | Start/stop control socket alongside the LarkChannel lifecycle |
| `tests/unit/handoff/jsonl-scan.test.ts` (new) | Tests for jsonl scanning helpers |
| `tests/unit/handoff/handoff-card.test.ts` (new) | Tests for card builder shape |
| `tests/unit/handoff/control-protocol.test.ts` (new) | Tests for wire encode/decode |
| `tests/unit/handoff/control-socket.test.ts` (new) | Tests for socket server: round-trip request/response, error response, ECONNREFUSED |
| `tests/unit/handoff/handoff-handler.test.ts` (new) | Tests for handler orchestration with mocked deps |
| `tests/unit/handoff/cli-args.test.ts` (new) | Tests for commander argument parsing (mutual exclusion etc.) |
| `README.md` and `README.zh.md` (modify) | New "Session handoff" / "终端会话接管" section |

---

## Task 1: jsonl scan helpers

**Files:**
- Create: `src/agent/claude/jsonl-scan.ts`
- Test: `tests/unit/handoff/jsonl-scan.test.ts`

Reuses `encodeCwdForClaudeProjects` from `src/agent/claude/jsonl-path.ts`.

- [ ] **Step 1: Create test fixtures directory layout for the test**

The test will create a tmpdir with this structure under each test:

```
<tmp>/.claude/projects/<encoded(cwd)>/
  aaa-1111.jsonl   (mtime: 3 min ago, 3 lines, first user "early msg")
  bbb-2222.jsonl   (mtime: 1 min ago, 5 lines, first user "latest")
  ccc-3333.jsonl   (mtime: 2 min ago, 2 lines, no user message)
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/handoff/jsonl-scan.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickLatest,
  listCandidates,
  readPreview,
} from '../../../src/agent/claude/jsonl-scan.js';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';

const CWD = '/Users/test/proj';
const ENCODED = encodeCwdForClaudeProjects(CWD);

function setSecondsAgo(path: string, seconds: number): void {
  const t = (Date.now() - seconds * 1000) / 1000;
  utimesSync(path, t, t);
}

describe('jsonl-scan', () => {
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lcb-jsonl-'));
    dir = join(home, '.claude', 'projects', ENCODED);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('pickLatest returns the most recent jsonl by mtime', () => {
    const a = join(dir, 'aaa-1111.jsonl');
    const b = join(dir, 'bbb-2222.jsonl');
    writeFileSync(a, '');
    writeFileSync(b, '');
    setSecondsAgo(a, 180);
    setSecondsAgo(b, 60);
    const got = pickLatest({ home, cwd: CWD });
    expect(got?.sessionId).toBe('bbb-2222');
  });

  it('pickLatest returns null on empty/missing dir', () => {
    rmSync(dir, { recursive: true });
    expect(pickLatest({ home, cwd: CWD })).toBeNull();
  });

  it('listCandidates returns N most recent, mtime-desc', () => {
    const a = join(dir, 'aaa-1111.jsonl');
    const b = join(dir, 'bbb-2222.jsonl');
    const c = join(dir, 'ccc-3333.jsonl');
    writeFileSync(a, '');
    writeFileSync(b, '');
    writeFileSync(c, '');
    setSecondsAgo(a, 180);
    setSecondsAgo(b, 60);
    setSecondsAgo(c, 120);
    const got = listCandidates({ home, cwd: CWD, limit: 2 });
    expect(got.map((x) => x.sessionId)).toEqual(['bbb-2222', 'ccc-3333']);
  });

  it('readPreview extracts first user message and line count, truncating to 60 chars', () => {
    const path = join(dir, 'abc-9999.jsonl');
    const longMsg = '把 user_id 字段加到 audit log 里面，方便后续审计追踪每个请求的来源';
    const lines = [
      JSON.stringify({ type: 'summary', text: 'preamble' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: longMsg } }),
      JSON.stringify({ type: 'assistant', message: { content: 'ok' } }),
      'this is malformed json{',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');
    const preview = readPreview(path);
    expect(preview.lineCount).toBe(5);
    expect(preview.firstUserMessage.length).toBeLessThanOrEqual(60);
    expect(preview.firstUserMessage.startsWith('把 user_id 字段')).toBe(true);
  });

  it('readPreview returns empty preview when no user message exists', () => {
    const path = join(dir, 'def-0000.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: 'hi' } }) + '\n');
    const preview = readPreview(path);
    expect(preview.firstUserMessage).toBe('');
    expect(preview.lineCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- jsonl-scan`
Expected: FAIL with module not found `src/agent/claude/jsonl-scan.ts`.

- [ ] **Step 4: Implement**

Create `src/agent/claude/jsonl-scan.ts`:

```ts
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeCwdForClaudeProjects } from './jsonl-path.js';

export interface JsonlCandidate {
  sessionId: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

export interface JsonlPreview {
  firstUserMessage: string;
  lineCount: number;
  mtimeMs: number;
}

export interface ScanArgs {
  home: string;
  cwd: string;
}

const PREVIEW_MAX_CHARS = 60;

function scanDir(args: ScanArgs): JsonlCandidate[] {
  const dir = join(args.home, '.claude', 'projects', encodeCwdForClaudeProjects(args.cwd));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: JsonlCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    entries.push({
      sessionId: name.slice(0, -'.jsonl'.length),
      path: full,
      mtimeMs: s.mtimeMs,
      bytes: s.size,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

export function pickLatest(args: ScanArgs): JsonlCandidate | null {
  const all = scanDir(args);
  return all[0] ?? null;
}

export function listCandidates(args: ScanArgs & { limit: number }): JsonlCandidate[] {
  return scanDir(args).slice(0, args.limit);
}

export function readPreview(path: string): JsonlPreview {
  let buf: string;
  try {
    buf = readFileSync(path, 'utf8');
  } catch {
    return { firstUserMessage: '', lineCount: 0, mtimeMs: 0 };
  }
  const mtimeMs = (() => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const lines = buf.split('\n').filter((l) => l.length > 0);
  let firstUser = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (obj.type !== 'user') continue;
      const role = obj.message?.role;
      if (role !== 'user') continue;
      const content = obj.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
              .join(' ')
          : '';
      if (!text) continue;
      firstUser = text.length > PREVIEW_MAX_CHARS
        ? text.slice(0, PREVIEW_MAX_CHARS - 1) + '…'
        : text;
      break;
    } catch {
      continue;
    }
  }
  return { firstUserMessage: firstUser, lineCount: lines.length, mtimeMs };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- jsonl-scan`
Expected: PASS (5/5).

- [ ] **Step 6: Commit**

```bash
git add src/agent/claude/jsonl-scan.ts tests/unit/handoff/jsonl-scan.test.ts
git commit -m "feat(handoff): jsonl scan helpers for claude session discovery"
```

---

## Task 2: Handoff card builder

**Files:**
- Create: `src/card/handoff-card.ts`
- Test: `tests/unit/handoff/handoff-card.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/handoff/handoff-card.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHandoffCard } from '../../../src/card/handoff-card.js';

describe('handoff card', () => {
  it('builds a CardKit 2.0 card with all key fields rendered', () => {
    const card = buildHandoffCard({
      cwd: '/Users/test/proj',
      sessionId: 'abc12345-6789-4def-0000-111122223333',
      firstUserMessage: '把 user_id 字段加到 audit log',
      lineCount: 47,
      mtimeMs: Date.now() - 60 * 1000,
    });
    expect(card.schema).toBe('2.0');
    const flat = JSON.stringify(card);
    expect(flat).toContain('/Users/test/proj');
    expect(flat).toContain('abc12345-6789-4def-0000-111122223333');
    expect(flat).toContain('把 user_id 字段加到 audit log');
    expect(flat).toContain('47');
    expect(flat).toContain('/resume');
  });

  it('handles empty preview gracefully', () => {
    const card = buildHandoffCard({
      cwd: '/x',
      sessionId: 'a',
      firstUserMessage: '',
      lineCount: 0,
      mtimeMs: Date.now(),
    });
    expect(JSON.stringify(card)).not.toContain('undefined');
  });

  it('formats relative time as "刚刚" for < 60s', () => {
    const card = buildHandoffCard({
      cwd: '/x',
      sessionId: 'a',
      firstUserMessage: 'foo',
      lineCount: 1,
      mtimeMs: Date.now() - 5_000,
    });
    expect(JSON.stringify(card)).toContain('刚刚');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- handoff-card`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `src/card/handoff-card.ts`:

```ts
export interface HandoffCardInput {
  cwd: string;
  sessionId: string;
  firstUserMessage: string;
  lineCount: number;
  mtimeMs: number;
}

export interface HandoffCard {
  schema: '2.0';
  config: { wide_screen_mode: boolean };
  header: { title: { tag: 'plain_text'; content: string } };
  body: { elements: unknown[] };
}

function relTime(mtimeMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

export function buildHandoffCard(input: HandoffCardInput): HandoffCard {
  const previewLine = input.firstUserMessage || '(无预览)';
  const time = relTime(input.mtimeMs);

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔗 已接管终端 Claude 会话' },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**项目**\n\`${input.cwd}\``,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**Session ID**\n\`${input.sessionId}\``,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**主题**\n${previewLine}`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**对话**\n${input.lineCount} 条 · ${time}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '直接发消息继续 · 回 /resume 可切回旧会话' },
          ],
        },
      ],
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- handoff-card`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/card/handoff-card.ts tests/unit/handoff/handoff-card.test.ts
git commit -m "feat(handoff): notification card builder"
```

---

## Task 3: Control-socket wire protocol

**Files:**
- Create: `src/runtime/control-protocol.ts`
- Test: `tests/unit/handoff/control-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/handoff/control-protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  type ControlRequest,
  type ControlResponse,
} from '../../../src/runtime/control-protocol.js';

describe('control protocol', () => {
  it('round-trips a handoff request', () => {
    const req: ControlRequest = {
      op: 'handoff',
      cwd: '/Users/test/proj',
      sessionId: 'abc-1234',
    };
    const wire = encodeRequest(req);
    expect(wire.endsWith('\n')).toBe(true);
    expect(decodeRequest(wire)).toEqual(req);
  });

  it('round-trips an ok response', () => {
    const res: ControlResponse = {
      ok: true,
      sessionIdShort: 'abc-1234',
      scopeId: 'p2p:oc_xxx',
      lineCount: 47,
      preview: 'topic',
    };
    expect(decodeResponse(encodeResponse(res))).toEqual(res);
  });

  it('round-trips an error response', () => {
    const res: ControlResponse = {
      ok: false,
      error: 'session-not-found',
      detail: 'no jsonl',
    };
    expect(decodeResponse(encodeResponse(res))).toEqual(res);
  });

  it('decodeRequest throws on malformed JSON', () => {
    expect(() => decodeRequest('not-json\n')).toThrow();
  });

  it('decodeRequest throws on missing op', () => {
    expect(() => decodeRequest(JSON.stringify({}) + '\n')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- control-protocol`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/control-protocol.ts`:

```ts
export interface HandoffRequest {
  op: 'handoff';
  cwd: string;
  sessionId: string;
}

export type ControlRequest = HandoffRequest;

export interface OkResponse {
  ok: true;
  sessionIdShort: string;
  scopeId: string;
  lineCount: number;
  preview: string;
}

export interface ErrorResponse {
  ok: false;
  error:
    | 'session-not-found'
    | 'owner-chat-unreachable'
    | 'bridge-internal'
    | 'bad-request';
  detail?: string;
}

export type ControlResponse = OkResponse | ErrorResponse;

export function encodeRequest(req: ControlRequest): string {
  return JSON.stringify(req) + '\n';
}

export function decodeRequest(wire: string): ControlRequest {
  const obj = JSON.parse(wire) as Partial<HandoffRequest>;
  if (obj.op !== 'handoff') {
    throw new Error(`bad-request: unknown op "${String(obj.op)}"`);
  }
  if (typeof obj.cwd !== 'string' || !obj.cwd) {
    throw new Error('bad-request: cwd required');
  }
  if (typeof obj.sessionId !== 'string' || !obj.sessionId) {
    throw new Error('bad-request: sessionId required');
  }
  return { op: 'handoff', cwd: obj.cwd, sessionId: obj.sessionId };
}

export function encodeResponse(res: ControlResponse): string {
  return JSON.stringify(res) + '\n';
}

export function decodeResponse(wire: string): ControlResponse {
  return JSON.parse(wire) as ControlResponse;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- control-protocol`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/control-protocol.ts tests/unit/handoff/control-protocol.test.ts
git commit -m "feat(handoff): control-socket wire protocol"
```

---

## Task 4: Control socket server

**Files:**
- Create: `src/runtime/control-socket.ts`
- Test: `tests/unit/handoff/control-socket.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/handoff/control-socket.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { startControlSocket } from '../../../src/runtime/control-socket.js';
import {
  encodeRequest,
  type ControlResponse,
} from '../../../src/runtime/control-protocol.js';

function clientRoundTrip(socketPath: string, reqWire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(socketPath, () => c.write(reqWire));
    const chunks: Buffer[] = [];
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    c.on('error', reject);
  });
}

describe('control socket', () => {
  it('dispatches handoff request to handler and returns response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-sock-'));
    const sockPath = join(dir, 'control.sock');
    let captured: unknown = null;
    const server = await startControlSocket({
      socketPath: sockPath,
      handlers: {
        handoff: async (req) => {
          captured = req;
          return {
            ok: true,
            sessionIdShort: 'abc-1234',
            scopeId: 'p2p:oc_test',
            lineCount: 7,
            preview: 'hi',
          };
        },
      },
    });
    try {
      const wire = await clientRoundTrip(
        sockPath,
        encodeRequest({ op: 'handoff', cwd: '/x', sessionId: 'abc-1234' }),
      );
      const res = JSON.parse(wire) as ControlResponse;
      expect(res.ok).toBe(true);
      expect(captured).toEqual({ op: 'handoff', cwd: '/x', sessionId: 'abc-1234' });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns bad-request when handler input is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-sock-'));
    const sockPath = join(dir, 'control.sock');
    const server = await startControlSocket({
      socketPath: sockPath,
      handlers: { handoff: async () => ({ ok: true, sessionIdShort: '', scopeId: '', lineCount: 0, preview: '' }) },
    });
    try {
      const wire = await clientRoundTrip(sockPath, 'not-json\n');
      const res = JSON.parse(wire) as ControlResponse;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('bad-request');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlinks stale socket on startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-sock-'));
    const sockPath = join(dir, 'control.sock');
    const a = await startControlSocket({
      socketPath: sockPath,
      handlers: { handoff: async () => ({ ok: true, sessionIdShort: '', scopeId: '', lineCount: 0, preview: '' }) },
    });
    await a.close({ unlink: false }); // simulate crash: socket file remains
    const b = await startControlSocket({
      socketPath: sockPath,
      handlers: { handoff: async () => ({ ok: true, sessionIdShort: 'ok', scopeId: 'p2p:x', lineCount: 0, preview: '' }) },
    });
    try {
      const wire = await clientRoundTrip(
        sockPath,
        encodeRequest({ op: 'handoff', cwd: '/x', sessionId: 'y' }),
      );
      const res = JSON.parse(wire) as ControlResponse;
      expect(res.ok).toBe(true);
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- control-socket`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/control-socket.ts`:

```ts
import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import {
  decodeRequest,
  encodeResponse,
  type ControlResponse,
  type HandoffRequest,
} from './control-protocol.js';

export interface ControlHandlers {
  handoff: (req: HandoffRequest) => Promise<ControlResponse>;
}

export interface ControlSocketServer {
  close(opts?: { unlink?: boolean }): Promise<void>;
}

export interface StartControlSocketOptions {
  socketPath: string;
  handlers: ControlHandlers;
}

export async function startControlSocket(
  opts: StartControlSocketOptions,
): Promise<ControlSocketServer> {
  // Unlink stale socket file from a prior crashed bridge before binding.
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // not present — fine
  }

  const server: Server = createServer((sock) => handleConnection(sock, opts.handlers));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    chmodSync(opts.socketPath, 0o600);
  } catch {
    // best-effort
  }

  return {
    async close(closeOpts) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (closeOpts?.unlink !== false) {
        try {
          unlinkSync(opts.socketPath);
        } catch {
          // already gone
        }
      }
    },
  };
}

function handleConnection(sock: Socket, handlers: ControlHandlers): void {
  const chunks: Buffer[] = [];
  sock.on('data', (d) => chunks.push(d));
  sock.on('end', () => {
    void respond(sock, Buffer.concat(chunks).toString('utf8'), handlers);
  });
  sock.on('error', () => {
    // ignore client-side close
  });
}

async function respond(
  sock: Socket,
  wire: string,
  handlers: ControlHandlers,
): Promise<void> {
  let response: ControlResponse;
  try {
    const req = decodeRequest(wire);
    response = await handlers.handoff(req);
  } catch (err) {
    response = {
      ok: false,
      error: 'bad-request',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  sock.end(encodeResponse(response));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- control-socket`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/control-socket.ts tests/unit/handoff/control-socket.test.ts
git commit -m "feat(handoff): unix-domain control socket server"
```

---

## Task 5: Handoff handler

**Files:**
- Create: `src/runtime/handoff-handler.ts`
- Test: `tests/unit/handoff/handoff-handler.test.ts`

The handler talks to the session catalog, sessions store, the agent (for PTY release), and the channel. We inject all of them so the test can use mocks.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/handoff/handoff-handler.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';
import { createHandoffHandler } from '../../../src/runtime/handoff-handler.js';

function makeJsonl(home: string, cwd: string, sessionId: string, content: string): string {
  const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}

const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n';

describe('handoff handler', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lcb-handoff-'));
  });

  function makeDeps(overrides: Partial<Parameters<typeof createHandoffHandler>[0]> = {}) {
    const ownerScope = 'p2p:oc_owner';
    const ownerChatId = 'oc_owner';
    const sessions = {
      getRaw: vi.fn().mockReturnValue({ sessionId: 'old-session' }),
      set: vi.fn(),
    };
    const sessionCatalog = {
      upsertActive: vi.fn(),
    };
    const agent = {
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const activeRuns = {
      interrupt: vi.fn(),
    };
    const resolveOwnerScope = vi
      .fn()
      .mockResolvedValue({ scopeId: ownerScope, chatId: ownerChatId });
    return {
      home,
      sessions,
      sessionCatalog,
      agent,
      channel,
      activeRuns,
      resolveOwnerScope,
      currentPolicyFingerprint: () => 'fp-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
      _expose: { ownerScope, ownerChatId },
    };
  }

  it('orchestrates the happy path: interrupt → close old PTY → upsert → set → send card', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 'new-session', userLine);
    const deps = makeDeps();
    const handle = createHandoffHandler(deps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 'new-session' });

    expect(res.ok).toBe(true);
    const callOrder = [
      deps.activeRuns.interrupt.mock.invocationCallOrder[0]!,
      deps.agent.closeSession.mock.invocationCallOrder[0]!,
      deps.sessionCatalog.upsertActive.mock.invocationCallOrder[0]!,
      deps.sessions.set.mock.invocationCallOrder[0]!,
      deps.channel.send.mock.invocationCallOrder[0]!,
    ];
    expect(callOrder).toEqual([...callOrder].sort((a, b) => a - b));
    expect(deps.agent.closeSession).toHaveBeenCalledWith('old-session');
    expect(deps.sessions.set).toHaveBeenCalledWith(
      deps._expose.ownerScope,
      'new-session',
      cwd,
    );
    expect(deps.channel.send).toHaveBeenCalledWith(
      deps._expose.ownerChatId,
      expect.objectContaining({ card: expect.any(Object) }),
    );
  });

  it('does NOT close prev PTY when sessionId matches active session', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 'same-session', userLine);
    const deps = makeDeps();
    deps.sessions.getRaw.mockReturnValue({ sessionId: 'same-session' });
    const handle = createHandoffHandler(deps);
    await handle({ op: 'handoff', cwd, sessionId: 'same-session' });
    expect(deps.agent.closeSession).not.toHaveBeenCalled();
  });

  it('returns session-not-found and does NOT mutate state when jsonl missing', async () => {
    const cwd = '/Users/test/proj';
    const deps = makeDeps();
    const handle = createHandoffHandler(deps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 'ghost' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('session-not-found');
    expect(deps.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(deps.sessions.set).not.toHaveBeenCalled();
    expect(deps.channel.send).not.toHaveBeenCalled();
  });

  it('returns owner-chat-unreachable when resolveOwnerScope returns null', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 's', userLine);
    const deps = makeDeps({ resolveOwnerScope: vi.fn().mockResolvedValue(null) });
    const handle = createHandoffHandler(deps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 's' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('owner-chat-unreachable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- handoff-handler`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/handoff-handler.ts`:

```ts
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { encodeCwdForClaudeProjects } from '../agent/claude/jsonl-path.js';
import { readPreview } from '../agent/claude/jsonl-scan.js';
import { buildHandoffCard } from '../card/handoff-card.js';
import type {
  HandoffRequest,
  ControlResponse,
} from './control-protocol.js';

export interface HandoffDeps {
  home: string;
  sessions: {
    getRaw(scope: string): { sessionId?: string } | undefined;
    set(scope: string, sessionId: string, cwd: string): void;
  };
  sessionCatalog: {
    upsertActive(entry: {
      scopeId: string;
      agentId: 'claude';
      cwdRealpath: string;
      policyFingerprint: string;
      sessionId: string;
    }): void;
  };
  agent: {
    closeSession?: (sessionId: string) => Promise<void>;
  };
  channel: {
    send(chatId: string, payload: { card: unknown }): Promise<void>;
  };
  activeRuns: {
    interrupt(scope: string): void;
  };
  resolveOwnerScope(): Promise<{ scopeId: string; chatId: string } | null>;
  currentPolicyFingerprint(): string;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

export function createHandoffHandler(deps: HandoffDeps) {
  return async function handoff(req: HandoffRequest): Promise<ControlResponse> {
    const dir = join(deps.home, '.claude', 'projects', encodeCwdForClaudeProjects(req.cwd));
    const jsonlPath = join(dir, `${req.sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) {
      return {
        ok: false,
        error: 'session-not-found',
        detail: `no jsonl at ${jsonlPath}`,
      };
    }

    const owner = await deps.resolveOwnerScope();
    if (!owner) {
      return {
        ok: false,
        error: 'owner-chat-unreachable',
        detail: 'owner p2p scope not resolvable',
      };
    }

    try {
      deps.activeRuns.interrupt(owner.scopeId);

      const prev = deps.sessions.getRaw(owner.scopeId)?.sessionId;
      if (prev && prev !== req.sessionId && deps.agent.closeSession) {
        await deps.agent.closeSession(prev);
      }

      deps.sessionCatalog.upsertActive({
        scopeId: owner.scopeId,
        agentId: 'claude',
        cwdRealpath: req.cwd,
        policyFingerprint: deps.currentPolicyFingerprint(),
        sessionId: req.sessionId,
      });
      deps.sessions.set(owner.scopeId, req.sessionId, req.cwd);

      const preview = readPreview(jsonlPath);
      const card = buildHandoffCard({
        cwd: req.cwd,
        sessionId: req.sessionId,
        firstUserMessage: preview.firstUserMessage,
        lineCount: preview.lineCount,
        mtimeMs: preview.mtimeMs,
      });
      await deps.channel.send(owner.chatId, { card });

      deps.logger.info('handoff completed', {
        scopeId: owner.scopeId,
        sessionId: req.sessionId,
        cwd: req.cwd,
      });

      return {
        ok: true,
        sessionIdShort: req.sessionId.slice(0, 8),
        scopeId: owner.scopeId,
        lineCount: preview.lineCount,
        preview: preview.firstUserMessage,
      };
    } catch (err) {
      deps.logger.error('handoff failed', {
        sessionId: req.sessionId,
        cwd: req.cwd,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error: 'bridge-internal',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- handoff-handler`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/runtime/handoff-handler.ts tests/unit/handoff/handoff-handler.test.ts
git commit -m "feat(handoff): bridge-side handoff handler"
```

---

## Task 6: Wire control socket into bridge lifecycle

**Files:**
- Modify: `src/bot/channel.ts` (add socket start/close to `startChannel`)

Note: the resolve-owner-scope and policy fingerprint helpers are wired up using already-existing primitives — `controls.botOwnerId` (from `src/policy/owner.ts`) and the per-profile policy fingerprint already used by `commandSessionCatalogIdentity`.

- [ ] **Step 1: Read existing startChannel signature**

Open `src/bot/channel.ts` near line 173. Identify `disconnect` return, the `channel.send` accessor on `LarkChannel`, and how `BridgeChannel` is returned.

- [ ] **Step 2: Add socket startup**

Edit `src/bot/channel.ts`. Inside `startChannel`, after the `LarkChannel` is constructed but before returning, insert:

```ts
import { startControlSocket } from '../runtime/control-socket.js';
import { createHandoffHandler } from '../runtime/handoff-handler.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
```

(Add only those not already imported.)

Then after the LarkChannel is constructed (look for the `return { channel, disconnect }` block):

```ts
const profileDir = deps.appPaths
  ? join(deps.appPaths.mediaDir, '..')
  : undefined;
const socketPath = profileDir ? join(profileDir, 'control.sock') : undefined;

const handoffHandler = createHandoffHandler({
  home: homedir(),
  sessions,
  sessionCatalog: sessionCatalog ?? { upsertActive: () => {} },
  agent,
  channel: { send: (chatId, payload) => channel.send(chatId, payload) },
  activeRuns,
  resolveOwnerScope: async () => {
    const ownerId = controls.botOwnerId;
    if (!ownerId) return null;
    // Owner's p2p chatId is recorded in sessions when the owner has DM'd
    // the bot at least once. We look up the first p2p scope owned by them.
    const scopeId = findOwnerP2pScope(sessions, ownerId);
    if (!scopeId) return null;
    const chatId = scopeId.replace(/^p2p:/, '');
    return { scopeId, chatId };
  },
  currentPolicyFingerprint: () => activePolicyFingerprints.get('owner') ?? 'default',
  logger: {
    info: (msg, ctx) => log.info('handoff', msg, ctx),
    warn: (msg, ctx) => log.warn('handoff', msg, ctx),
    error: (msg, ctx) => log.error('handoff', msg, ctx),
  },
});

let controlServer: { close(): Promise<void> } | undefined;
if (socketPath) {
  try {
    controlServer = await startControlSocket({
      socketPath,
      handlers: { handoff: handoffHandler },
    });
    log.info('control_socket', 'listening', { socketPath });
  } catch (err) {
    log.warn('control_socket', 'listen_failed', {
      socketPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
```

And inside the existing `disconnect`, before its existing teardown, add:

```ts
await controlServer?.close();
```

Also add this helper at module scope (top of file or near other helpers):

```ts
function findOwnerP2pScope(
  sessions: SessionStore,
  ownerOpenId: string,
): string | undefined {
  for (const scope of sessions.allScopes()) {
    if (!scope.startsWith('p2p:')) continue;
    const meta = sessions.getMeta?.(scope);
    if (meta?.senderId === ownerOpenId) return scope;
  }
  return undefined;
}
```

If `sessions.allScopes()` / `sessions.getMeta()` don't exist on `SessionStore`, add minimal accessors to `src/session/store.ts` returning the in-memory map keys and metadata. Do NOT widen the public API beyond what the handoff needs.

- [ ] **Step 3: Add a smoke test that does NOT exercise the real LarkChannel**

Skip a unit test here — the wiring is exercised by Task 10's manual smoke. Keep this task to integration glue.

- [ ] **Step 4: Verify build still passes**

```bash
pnpm typecheck
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/bot/channel.ts src/session/store.ts
git commit -m "feat(handoff): start control socket from bridge lifecycle"
```

---

## Task 7: CLI handoff command (client side)

**Files:**
- Create: `src/cli/commands/handoff.ts`
- Test: `tests/unit/handoff/cli-args.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/handoff/cli-args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseHandoffArgs } from '../../../src/cli/commands/handoff.js';

describe('handoff cli args', () => {
  it('returns defaults when no flags', () => {
    const opts = parseHandoffArgs({});
    expect(opts.list).toBe(false);
    expect(opts.session).toBeUndefined();
  });

  it('accepts --session', () => {
    expect(parseHandoffArgs({ session: 'abc' }).session).toBe('abc');
  });

  it('accepts --list', () => {
    expect(parseHandoffArgs({ list: true }).list).toBe(true);
  });

  it('rejects --session combined with --list', () => {
    expect(() => parseHandoffArgs({ session: 'abc', list: true })).toThrow(
      /mutually exclusive/i,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- cli-args`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement**

Create `src/cli/commands/handoff.ts`:

```ts
import { connect } from 'node:net';
import { join } from 'node:path';
import { platform, homedir } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { encodeCwdForClaudeProjects } from '../../agent/claude/jsonl-path.js';
import {
  encodeRequest,
  decodeResponse,
  type ControlResponse,
} from '../../runtime/control-protocol.js';

export interface HandoffOpts {
  session?: string;
  list?: boolean;
  cwd?: string;
  profile?: string;
}

export interface ParsedHandoffOpts {
  session: string | undefined;
  list: boolean;
  cwd: string | undefined;
  profile: string | undefined;
}

export function parseHandoffArgs(raw: HandoffOpts): ParsedHandoffOpts {
  if (raw.session && raw.list) {
    throw new Error('--session and --list are mutually exclusive');
  }
  return {
    session: raw.session,
    list: raw.list === true,
    cwd: raw.cwd,
    profile: raw.profile,
  };
}

export async function runHandoff(raw: HandoffOpts): Promise<number> {
  if (platform() === 'win32') {
    process.stderr.write(
      'handoff is not supported on Windows. Use `claude --resume <id>` locally instead.\n',
    );
    return 1;
  }
  const opts = parseHandoffArgs(raw);
  const cwd = opts.cwd ?? process.cwd();
  const home = homedir();
  const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));

  if (opts.list) {
    return printCandidatesAndExit(dir);
  }

  const sessionId = opts.session ?? pickLatestSessionId(dir);
  if (!sessionId) {
    process.stderr.write(
      `no claude session jsonl found under ${dir}\n`,
    );
    return 1;
  }

  const socketPath = await resolveSocketPath(opts.profile);
  if (!socketPath || !existsSync(socketPath)) {
    process.stderr.write(
      `bridge not running. start it with 'lark-channel-bridge start${opts.profile ? ` --profile ${opts.profile}` : ''}'\n`,
    );
    return 1;
  }

  try {
    const res = await sendRequest(socketPath, {
      op: 'handoff',
      cwd,
      sessionId,
    });
    if (res.ok) {
      process.stdout.write(
        `已推送会话 ${res.sessionIdShort} 到飞书私聊（${res.lineCount} 条对话）。\n`,
      );
      return 0;
    }
    process.stderr.write(`handoff failed: ${res.error}${res.detail ? `\n${res.detail}` : ''}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `failed to talk to bridge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function pickLatestSessionId(dir: string): string | undefined {
  try {
    const names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    let best: { id: string; mtimeMs: number } | undefined;
    for (const name of names) {
      const s = statSync(join(dir, name));
      if (!s.isFile()) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!best || s.mtimeMs > best.mtimeMs) best = { id, mtimeMs: s.mtimeMs };
    }
    return best?.id;
  } catch {
    return undefined;
  }
}

function printCandidatesAndExit(dir: string): number {
  try {
    const names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    const entries = names
      .map((name) => {
        const s = statSync(join(dir, name));
        return { id: name.slice(0, -'.jsonl'.length), mtimeMs: s.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 10);
    if (entries.length === 0) {
      process.stdout.write('no candidates\n');
      return 0;
    }
    for (const e of entries) {
      const ago = Math.floor((Date.now() - e.mtimeMs) / 1000);
      process.stdout.write(`${e.id}  (${ago}s ago)\n`);
    }
    return 0;
  } catch {
    process.stdout.write('no candidates\n');
    return 0;
  }
}

async function resolveSocketPath(profileName: string | undefined): Promise<string | undefined> {
  // Reuse existing profile-discovery for the profile dir. Profile-discovery
  // is already loaded by other CLI commands.
  const { resolveProfileDir } = await import('../../runtime/profile-discovery.js');
  const dir = await resolveProfileDir(profileName);
  if (!dir) return undefined;
  return join(dir, 'control.sock');
}

function sendRequest(
  socketPath: string,
  req: { op: 'handoff'; cwd: string; sessionId: string },
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => sock.end(encodeRequest(req)));
    const chunks: Buffer[] = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      try {
        resolve(decodeResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
  });
}
```

If `src/runtime/profile-discovery.ts` does not expose `resolveProfileDir`, add a thin export that returns the same profile dir already used by `start.ts` for `mediaDir`'s parent. Do not introduce a parallel discovery path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- cli-args`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/handoff.ts tests/unit/handoff/cli-args.test.ts src/runtime/profile-discovery.ts
git commit -m "feat(handoff): cli command and client"
```

(Include `profile-discovery.ts` in the commit only if it was modified.)

---

## Task 8: Register `handoff` in commander

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Add import**

Near the top of `src/cli/index.ts` with the other command imports:

```ts
import { runHandoff } from './commands/handoff.js';
```

- [ ] **Step 2: Register the command**

Add this block after the existing `program.command('kill <target>')` registration (line ~145, in the "process-level commands" section):

```ts
program
  .command('handoff')
  .description('Park the latest local Claude session into the owner Lark p2p chat')
  .option('--session <id>', 'explicit session id (default: latest mtime under cwd)')
  .option('--list', 'list candidate session ids under cwd and exit')
  .option('--cwd <path>', 'override cwd (default: process.cwd())')
  .option('--profile <name>', 'target profile (default: active profile)')
  .action(async (opts: { session?: string; list?: boolean; cwd?: string; profile?: string }) => {
    const code = await runHandoff(opts);
    process.exit(code);
  });
```

- [ ] **Step 3: Verify**

```bash
pnpm build
node dist/cli.js handoff --help
```

Expected: help text shows the four flags described in the spec.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(handoff): register handoff command in cli"
```

---

## Task 9: README documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: Add "Session handoff" section to `README.zh.md`**

Insert after the "### Claude 会话的持久化方式" section (currently around line 192):

````markdown
### 终端会话接管（handoff）

在本机终端跑 `claude` 跑到一半，想换到手机上继续？用 `handoff`：

```bash
# 终端：先在 claude 里 /exit
lark-channel-bridge handoff
# → 已推送会话 abc12345 到飞书私聊（47 条对话）
```

bridge 会接管这个 session id，并发一张通知卡到 owner 的私聊。下一条飞书消息就接着这个会话继续聊（`claude --resume <id>`）。

参数：

```text
lark-channel-bridge handoff [--session <id>] [--list] [--cwd <path>] [--profile <name>]
```

注意事项：

- macOS / Linux only。Windows 不支持。
- 跑 `handoff` 之前**必须先 /exit 终端的 claude**，否则两个进程同时写同一份 jsonl 会乱。
- 卡片只是通知，不可点击；点错了想撤销，在飞书里发 `/resume` 切回旧会话即可。
- 旧的 bridge 会话不会被删，jsonl 还在原地，随时 `/resume` 切回。
````

- [ ] **Step 2: Add the same section to `README.md`** (English)

Mirror under "### How Claude sessions are persisted":

````markdown
### Session handoff (terminal → Lark)

Started a local `claude` session in your terminal but need to step away? `handoff` parks it into your Lark p2p chat with the bot:

```bash
# In the terminal — /exit your claude first
lark-channel-bridge handoff
# → handed off session abc12345 (47 turns)
```

Bridge adopts the session id and posts a notification card to the owner's p2p. Your next Lark message continues the conversation via `claude --resume <id>`.

Flags:

```text
lark-channel-bridge handoff [--session <id>] [--list] [--cwd <path>] [--profile <name>]
```

Caveats:

- macOS / Linux only. Windows is not supported.
- You **must `/exit` the terminal claude** before invoking `handoff`. Two processes appending to the same jsonl will corrupt the session log.
- The card is informational. To revert, send `/resume` in Lark and pick the previous session.
- The previous bridge session is not deleted; its jsonl is preserved and resumable.
````

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs(handoff): document terminal→Lark session handoff"
```

---

## Task 10: Manual end-to-end smoke

**Files:**
- (no code changes — verification step)

- [ ] **Step 1: Rebuild and start a test bridge**

```bash
pnpm build
LARK_CHANNEL_HOME=/tmp/lcb-handoff-smoke ./bin/lark-channel-bridge.mjs run --profile claude
```

In another terminal:

- [ ] **Step 2: Start a local claude session**

```bash
cd ~/scratch/handoff-test    # any project dir
claude
# → say something like: "记住这个数字: 4242"
# → wait for response
# → /exit
```

- [ ] **Step 3: Hand off**

```bash
lark-channel-bridge handoff
```

Expected stdout: `已推送会话 <id> 到飞书私聊（N 条对话）。`

- [ ] **Step 4: Verify in Lark**

- Owner p2p receives the 🔗 notification card with project, session id, topic, conversation count, "刚刚".
- Send a Lark message: "刚才那个数字是多少？"
- Bridge replies "4242" (or similar) — confirming `claude --resume <id>` picked up the prior context.

- [ ] **Step 5: Verify `/resume` still works for falling back**

- In Lark p2p: `/resume`
- Card lists prior session ids; the bridge's pre-handoff session should be selectable.
- Pick it → next message continues that older context.

- [ ] **Step 6: Tear down**

```bash
rm -rf /tmp/lcb-handoff-smoke
```

- [ ] **Step 7: Final commit (optional)**

If any docs were tweaked during smoke:

```bash
git add -p
git commit -m "docs(handoff): smoke-driven tweaks"
```

---

## Final verification

```bash
pnpm test
pnpm typecheck
pnpm build
```

All three must pass before opening a PR.
