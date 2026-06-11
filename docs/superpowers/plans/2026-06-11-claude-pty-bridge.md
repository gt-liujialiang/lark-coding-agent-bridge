# Claude PTY Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bridge's `claude -p` adapter with a persistent PTY + JSONL-log-tail adapter, modeled on `seed-offline-tasks`, so the bridge keeps working after upstream removes `-p`.

**Architecture:** A `ClaudePtyPool` keyed by `claudeSessionId` owns long-lived `claude` PTYs spawned via `node-pty`. `ClaudeAdapter.run(opts)` returns an `AgentRun` whose `events` stream is produced by polling the per-session JSONL log at `~/.claude/projects/<encoded(cwd)>/<sessionId>.jsonl` until `stop_reason === "end_turn"`. PTYs are reused across turns within a Lark session and only torn down on `/new`, `/cd`, `/reset`, or hard failure.

**Tech Stack:** TypeScript, Node ≥ 20.12, `node-pty` (new native dep), `vitest`, `tsup`. macOS + Linux only — Windows is intentionally dropped from the Claude path.

**Reference spec:** `docs/superpowers/specs/2026-06-11-claude-pty-bridge-design.md`. Read it once before starting.

**Working principle:** Each task ends with a green test and a commit. Files referenced by later tasks are introduced in earlier tasks. Re-read the linked existing files (`src/agent/claude/adapter.ts`, `tests/process/claude-adapter.test.ts`, `seed-offline-tasks/internal/runner/runner.go`, `seed-offline-tasks/internal/runner/jsonl.go`, `seed-offline-tasks/internal/session/session.go`) when implementing — they are the canonical reference for the behaviors below.

---

## Task 0: Pre-flight setup — branch, dependency, CI matrix

**Files:**
- Modify: `lark-coding-agent-bridge/package.json`
- Modify: `lark-coding-agent-bridge/.github/workflows/ci.yml`
- Modify: `lark-coding-agent-bridge/README.md`
- Modify: `lark-coding-agent-bridge/README.zh.md`

- [ ] **Step 1: Create a feature branch from `main`**

```bash
cd lark-coding-agent-bridge
git checkout -b feat/claude-pty-bridge
```

- [ ] **Step 2: Add `node-pty` as a runtime dependency and add it to the pnpm build allowlist**

Edit `package.json`:

```jsonc
{
  "dependencies": {
    "@clack/prompts": "^1.4.0",
    "@larksuite/channel": "^0.1.2",
    "commander": "^12.1.0",
    "cross-spawn": "^7.0.6",
    "graceful-fs": "^4.2.11",
    "node-pty": "^1.0.0",
    "proper-lockfile": "^4.1.2",
    "qrcode-terminal": "^0.12.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": [
      "esbuild",
      "node-pty",
      "protobufjs"
    ]
  }
}
```

- [ ] **Step 3: Install and verify the native build succeeds on host**

```bash
pnpm install
node -e "import('node-pty').then(m => console.log('node-pty ok'))"
```

Expected: `node-pty ok` prints with no errors. If the build fails, install Xcode CLT (`xcode-select --install`) on macOS or `build-essential` on Linux.

- [ ] **Step 4: Drop `windows-latest` from CI matrix**

Edit `.github/workflows/ci.yml`:

```yaml
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, ubuntu-latest]
```

- [ ] **Step 5: Document the Windows regression in README**

In both `README.md` and `README.zh.md`, add right after the "Prerequisites" header:

```markdown
- macOS or Linux. **Windows is not supported as of 0.4.0** (the Claude adapter
  now relies on a PTY-based session manager that is not validated on Windows).
  Codex is unaffected.
```

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .github/workflows/ci.yml README.md README.zh.md
git commit -m "chore: add node-pty dep and drop windows from CI"
```

---

## Task 1: Bridge utility — derive the JSONL path Claude writes to

**Files:**
- Create: `lark-coding-agent-bridge/src/agent/claude/jsonl-path.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/claude-jsonl-path.test.ts`

**Why:** Both the JSONL reader and the PtySession need to compute
`~/.claude/projects/<encoded(cwd)>/<sessionId>.jsonl`. Isolating this in one
module keeps the convention swappable in one place if Claude ever renames it.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude-jsonl-path.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { encodeCwdForClaudeProjects, sessionJsonlPath } from '../../../src/agent/claude/jsonl-path.js';

describe('claudeJsonlPath', () => {
  it('encodes a posix cwd by replacing / with -', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/proj')).toBe('-Users-me-proj');
  });

  it('cleans the cwd before encoding', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/../me/proj//x/')).toBe('-Users-me-proj-x');
  });

  it('builds a JSONL path under ~/.claude/projects', () => {
    const p = sessionJsonlPath({
      home: '/Users/me',
      cwd: '/Users/me/proj',
      sessionId: 'abc-123',
    });
    expect(p).toBe('/Users/me/.claude/projects/-Users-me-proj/abc-123.jsonl');
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:unit -- tests/unit/agent/claude-jsonl-path.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the module**

Create `src/agent/claude/jsonl-path.ts`:

```typescript
import { posix, sep } from 'node:path';

/**
 * Mirror of `~/.claude/projects/` layout: each project dir is named after its
 * cwd with every path separator replaced by `-` (cwd is cleaned first to
 * collapse `..` and double-slashes).
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  // Always treat cwd as POSIX — claude writes the same shape on macOS/Linux.
  const cleaned = posix.normalize(cwd.split(sep).join('/')).replace(/\/+$/, '');
  return cleaned.replace(/\//g, '-');
}

export function sessionJsonlPath(input: {
  home: string;
  cwd: string;
  sessionId: string;
}): string {
  const dir = encodeCwdForClaudeProjects(input.cwd);
  return posix.join(input.home, '.claude', 'projects', dir, `${input.sessionId}.jsonl`);
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/claude-jsonl-path.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/jsonl-path.ts tests/unit/agent/claude-jsonl-path.test.ts
git commit -m "feat(agent): claude jsonl-path helper"
```

---

## Task 2: Incremental JSONL reader

**Files:**
- Create: `lark-coding-agent-bridge/src/agent/claude/jsonl-reader.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/claude-jsonl-reader.test.ts`

**Why:** A focused tailer for the session JSONL. Holds a line cursor, parses
each line as JSON, and returns the new entries since last call. No PTY
involvement — easy to test against a fixture file. Mirrors `readNewEntries` in
`seed-offline-tasks/internal/runner/jsonl.go`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude-jsonl-reader.test.ts`:

```typescript
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlReader } from '../../../src/agent/claude/jsonl-reader.js';

describe('JsonlReader', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('returns no entries when the file does not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const r = new JsonlReader(join(dir, 'missing.jsonl'));
    const { entries, lineCount } = await r.readNew();
    expect(entries).toEqual([]);
    expect(lineCount).toBe(0);
  });

  it('reads only entries past the cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    await writeFile(path,
      `${JSON.stringify({ a: 1 })}\n` +
      `${JSON.stringify({ a: 2 })}\n`,
    );
    const r = new JsonlReader(path);
    const first = await r.readNew();
    expect(first.entries).toEqual([{ a: 1 }, { a: 2 }]);
    expect(first.lineCount).toBe(2);

    await appendFile(path, `${JSON.stringify({ a: 3 })}\n`);
    const second = await r.readNew();
    expect(second.entries).toEqual([{ a: 3 }]);
    expect(second.lineCount).toBe(3);
  });

  it('skips blank lines and tolerates a trailing partial line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    await writeFile(path,
      `${JSON.stringify({ ok: true })}\n` +
      `\n` +
      `{"partial":`,
    );
    const r = new JsonlReader(path);
    const result = await r.readNew();
    expect(result.entries).toEqual([{ ok: true }]);
    // Partial trailing line is not counted as complete — cursor stays before it
    // so a follow-up readNew picks it up when the line finishes.
    expect(result.lineCount).toBe(1);
  });

  it('allows seeking the cursor forward', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    await writeFile(path,
      `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n`,
    );
    const r = new JsonlReader(path);
    r.setCursor(1);
    const { entries } = await r.readNew();
    expect(entries).toEqual([{ a: 2 }]);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:unit -- tests/unit/agent/claude-jsonl-reader.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the reader**

Create `src/agent/claude/jsonl-reader.ts`:

```typescript
import { open } from 'node:fs/promises';

export interface JsonlReadResult {
  entries: Record<string, unknown>[];
  lineCount: number;
}

/**
 * Tails a JSONL file by line index. Each call returns the entries appended
 * since the last call. A trailing partial line (no terminating "\n") is held
 * back until the writer finishes it — the cursor only advances past complete
 * lines, so polling is idempotent.
 */
export class JsonlReader {
  private cursor = 0;
  private leftover = '';

  constructor(private readonly path: string, private readonly maxLineBytes = 16 * 1024 * 1024) {}

  setCursor(line: number): void {
    this.cursor = Math.max(0, Math.floor(line));
    this.leftover = '';
  }

  async readNew(): Promise<JsonlReadResult> {
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], lineCount: this.cursor };
      }
      throw err;
    }
    try {
      const stat = await handle.stat();
      // 1 MB read window per pass; loop until we've consumed the file.
      const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(64 * 1024, stat.size)));
      const lines: string[] = [];
      let offset = 0;
      let buffered = this.leftover;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        buffered += buf.subarray(0, bytesRead).toString('utf8');
        let nl = buffered.indexOf('\n');
        while (nl !== -1) {
          lines.push(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
          if (buffered.length > this.maxLineBytes) {
            throw new Error(`JsonlReader: line exceeds ${this.maxLineBytes} bytes`);
          }
          nl = buffered.indexOf('\n');
        }
      }
      this.leftover = buffered;

      const entries: Record<string, unknown>[] = [];
      let lineCount = 0;
      for (const raw of lines) {
        lineCount += 1;
        if (lineCount <= this.cursor) continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Malformed line — skip, matches seed behavior.
        }
      }
      this.cursor = lineCount;
      return { entries, lineCount };
    } finally {
      await handle.close();
    }
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/claude-jsonl-reader.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/jsonl-reader.ts tests/unit/agent/claude-jsonl-reader.test.ts
git commit -m "feat(agent): incremental jsonl reader for claude session logs"
```

---

## Task 3: JSONL entry → `AgentEvent` translator (supersedes `stream-json.ts`)

**Files:**
- Create: `lark-coding-agent-bridge/src/agent/claude/jsonl-translate.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/claude-jsonl-translate.test.ts`

**Why:** Different input shape (one JSONL entry vs. one stream-json line), but
output is still our `AgentEvent`. Logic ports from `stream-json.ts` with:
- No `type:'result'` branch (no such entry in the JSONL).
- An end-of-turn synthesizer: when an assistant entry's `message.stop_reason`
  is `"end_turn"`, emit a `usage` event (summed across the turn's assistant
  entries) then `done { terminationReason: 'normal' }`.

The translator is **stateful per turn**: it accumulates usage so it can emit a
single `usage` event at end-of-turn, mirroring `sumUsage` in
`seed-offline-tasks/internal/runner/jsonl.go`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude-jsonl-translate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { JsonlTurnTranslator } from '../../../src/agent/claude/jsonl-translate.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function run(entries: unknown[]): AgentEvent[] {
  const t = new JsonlTurnTranslator();
  const out: AgentEvent[] = [];
  for (const e of entries) for (const ev of t.translate(e)) out.push(ev);
  return out;
}

describe('JsonlTurnTranslator', () => {
  it('translates assistant text and tool_use blocks', () => {
    expect(run([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
    ])).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates thinking blocks', () => {
    expect(run([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }] } },
    ])).toEqual([{ type: 'thinking', delta: 'plan' }]);
  });

  it('translates user tool_result, including structured + error', () => {
    expect(run([
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      },
    ])).toEqual([
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 't2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('synthesizes usage + done on end_turn, summing tokens across assistant entries', () => {
    const events = run([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'first half' }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 },
        },
      },
      {
        type: 'assistant',
        sessionId: 'sess-xyz',
        message: {
          content: [{ type: 'text', text: 'final' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 7 },
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'first half' },
      { type: 'text', delta: 'final' },
      { type: 'usage', inputTokens: 17, outputTokens: 12, cachedInputTokens: 4 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('ignores unknown / empty / partial entries', () => {
    expect(run([
      null,
      { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }, // no name
      { type: 'system', subtype: 'other' },
    ])).toEqual([]);
  });

  it('reports whether end_turn was seen', () => {
    const t = new JsonlTurnTranslator();
    for (const _ of t.translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })) {
      /* drain */
    }
    expect(t.endTurnSeen).toBe(false);
    for (const _ of t.translate({
      type: 'assistant',
      message: { content: [], stop_reason: 'end_turn' },
    })) {
      /* drain */
    }
    expect(t.endTurnSeen).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:unit -- tests/unit/agent/claude-jsonl-translate.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the translator**

Create `src/agent/claude/jsonl-translate.ts`:

```typescript
import type { AgentEvent } from '../types';

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AssistantMessage {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

interface UserMessage {
  content?: ContentBlock[];
}

interface JsonlEntry {
  type?: string;
  message?: AssistantMessage | UserMessage;
}

/**
 * Per-turn translator. One instance per `PtySession.runTurn()` so the
 * end-of-turn usage event correctly sums only the turn's assistant entries.
 *
 * Reads JSONL records written to `~/.claude/projects/<encoded>/<id>.jsonl`
 * and emits the bridge's `AgentEvent`. When an assistant entry carries
 * `stop_reason: "end_turn"`, the translator synthesizes a `usage` event
 * (summed across the turn) followed by a `done` event.
 */
export class JsonlTurnTranslator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private _endTurnSeen = false;

  get endTurnSeen(): boolean {
    return this._endTurnSeen;
  }

  *translate(raw: unknown): Generator<AgentEvent> {
    if (!raw || typeof raw !== 'object') return;
    const entry = raw as JsonlEntry;
    if (entry.type === 'assistant') {
      const message = entry.message as AssistantMessage | undefined;
      if (message?.usage) {
        const u = message.usage;
        this.inputTokens +=
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        this.outputTokens += u.output_tokens ?? 0;
        this.cachedInputTokens += u.cache_read_input_tokens ?? 0;
      }
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          yield { type: 'text', delta: block.text };
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          yield { type: 'thinking', delta: block.thinking };
        } else if (block.type === 'tool_use' && block.id && block.name) {
          yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
      }
      if (message?.stop_reason === 'end_turn' && !this._endTurnSeen) {
        this._endTurnSeen = true;
        yield {
          type: 'usage',
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          cachedInputTokens: this.cachedInputTokens,
        };
        yield { type: 'done', terminationReason: 'normal' };
      }
      return;
    }
    if (entry.type === 'user') {
      const message = entry.message as UserMessage | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const output =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          yield {
            type: 'tool_result',
            id: block.tool_use_id,
            output,
            isError: block.is_error === true,
          };
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/claude-jsonl-translate.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/jsonl-translate.ts tests/unit/agent/claude-jsonl-translate.test.ts
git commit -m "feat(agent): claude jsonl turn translator"
```

---

## Task 4: PTY abstraction layer (interface + thin `node-pty` adapter)

**Files:**
- Create: `lark-coding-agent-bridge/src/agent/claude/pty.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/claude-pty.test.ts`

**Why:** Decouple `PtySession` from `node-pty` so unit tests can stub the PTY
with a controllable fake. The interface is intentionally small: spawn,
write, on-data, on-exit, kill.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude-pty.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { spawnPty } from '../../../src/agent/claude/pty.js';

describe('spawnPty (node-pty bridge)', () => {
  it('returns a handle that can write input, receive output, and exit', async () => {
    // `cat` echoes whatever we write — perfect for round-tripping a byte.
    const pty = spawnPty({ file: '/bin/cat', args: [], cwd: process.cwd(), env: process.env as Record<string, string> });

    const chunks: string[] = [];
    pty.onData((s) => chunks.push(s));

    const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      pty.onExit(resolve);
    });

    pty.write('hello\n');
    // Give cat a tick to echo
    await new Promise((r) => setTimeout(r, 50));
    pty.kill('SIGTERM');
    const exit = await exited;

    expect(chunks.join('')).toMatch(/hello/);
    expect(typeof exit.exitCode).toBe('number');
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:unit -- tests/unit/agent/claude-pty.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the wrapper**

Create `src/agent/claude/pty.ts`:

```typescript
import * as nodePty from 'node-pty';

export interface PtyHandle {
  pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnPtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
}

/**
 * Thin wrapper around `node-pty` so the rest of the adapter can be unit-tested
 * against a stub PTY. Defaults to 220x200 to match `seed-offline-tasks` —
 * Claude's TUI uses screen width for line wrapping which affects the rolling
 * permission-detection buffer.
 */
export function spawnPty(opts: SpawnPtyOptions): PtyHandle {
  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string') filteredEnv[k] = v;
  }
  const cols = opts.cols ?? 220;
  const rows = opts.rows ?? 200;
  const proc = nodePty.spawn(opts.file, opts.args, {
    cwd: opts.cwd,
    env: {
      ...filteredEnv,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    cols,
    rows,
  });
  return {
    get pid() {
      return proc.pid;
    },
    write: (data) => proc.write(data),
    resize: (c, r) => proc.resize(c, r),
    onData: (listener) => {
      proc.onData(listener);
    },
    onExit: (listener) => {
      proc.onExit((e) => listener({ exitCode: e.exitCode, signal: e.signal }));
    },
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        // node-pty throws if the process is already gone; treat as no-op.
      }
    },
  };
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/claude-pty.test.ts
```

Expected: PASS (1 test) on macOS/Linux. On Windows, the test will skip via CI matrix exclusion.

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/pty.ts tests/unit/agent/claude-pty.test.ts
git commit -m "feat(agent): node-pty wrapper for claude adapter"
```

---

## Task 5: `PtySession` — one long-lived claude TUI + turn driver

**Files:**
- Create: `lark-coding-agent-bridge/src/agent/claude/pty-session.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/claude-pty-session.test.ts`

**Why:** This is the heart of the new adapter. It encapsulates one
long-lived claude PTY plus the turn-drive state machine (write prompt → poll
JSONL → emit events → detect `end_turn`). It uses the abstractions from
tasks 1-4 and is tested with a stub PTY plus a fixture JSONL file.

Each instance is **bound to one (cwd, claudeSessionId)** and reused across
many turns until explicitly closed.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude-pty-session.test.ts`:

```typescript
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';
import { PtySession } from '../../../src/agent/claude/pty-session.js';
import type { PtyHandle } from '../../../src/agent/claude/pty.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function createStubPty(): {
  handle: PtyHandle;
  writes: string[];
  emitData: (s: string) => void;
  emitExit: (code: number, signal?: number) => void;
} {
  const writes: string[] = [];
  const dataListeners: ((s: string) => void)[] = [];
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  return {
    writes,
    emitData: (s) => dataListeners.forEach((l) => l(s)),
    emitExit: (code, signal) => exitListeners.forEach((l) => l({ exitCode: code, signal })),
    handle: {
      pid: 1234,
      write: (d) => writes.push(d),
      resize: () => {},
      onData: (l) => { dataListeners.push(l); },
      onExit: (l) => { exitListeners.push(l); },
      kill: () => {},
    },
  };
}

describe('PtySession', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeJsonlHome(cwd: string, sessionId: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'pty-session-home-'));
    dirs.push(home);
    const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
    await mkdir(dir, { recursive: true });
    return home;
  }

  it('writes the prompt + delay + CR to the PTY and emits events drained from the JSONL', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-1';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
    });

    // Pre-populate the JSONL with two entries so runTurn finds them quickly.
    const jsonl = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd), `${sessionId}.jsonl`);
    setTimeout(async () => {
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi back' }] },
      }) + '\n');
      await appendFile(jsonl, JSON.stringify({
        type: 'assistant',
        message: {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      }) + '\n');
    }, 20);

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('hello')) events.push(ev);

    expect(stub.writes[0]).toBe('hello');
    expect(stub.writes[1]).toBe('\r');
    expect(events).toEqual([
      { type: 'text', delta: 'hi back' },
      { type: 'usage', inputTokens: 3, outputTokens: 4, cachedInputTokens: 0 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('auto-presses "2" when "I accept" appears in the rolling buffer (one-time)', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-2';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
    });

    // Emit the banner before the turn starts.
    stub.emitData('Bypass Permissions mode\n\n  1. No\n  2. Yes, I accept\n');

    // Wait one tick so the listener consumes data.
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.writes).toContain('2\r');

    // The same string appearing again must not re-press.
    const before = stub.writes.filter((w) => w === '2\r').length;
    stub.emitData('I accept\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(stub.writes.filter((w) => w === '2\r').length).toBe(before);
  });

  it('softInterrupt writes ESC and resolves done(interrupted) if the turn does not complete in grace', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-3';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
    });

    const iter = session.runTurn('long task')[Symbol.asyncIterator]();
    setTimeout(() => { void session.softInterrupt(20); }, 30);

    const ev = await iter.next();
    expect(ev.done).toBe(false);
    expect(ev.value).toEqual({ type: 'done', terminationReason: 'interrupted' });

    expect(stub.writes).toContain('\x1b');
  });

  it('emits error(failed) and stops iteration when the PTY exits mid-turn', async () => {
    const cwd = '/Users/me/proj';
    const sessionId = 'sess-4';
    const home = await makeJsonlHome(cwd, sessionId);
    const stub = createStubPty();
    const session = new PtySession({
      pty: stub.handle,
      cwd,
      sessionId,
      home,
      pollMs: 10,
      promptDelayMs: 5,
    });

    setTimeout(() => stub.emitExit(1, undefined), 30);

    const events: AgentEvent[] = [];
    for await (const ev of session.runTurn('bye')) events.push(ev);

    expect(events.at(-1)).toEqual({
      type: 'error',
      message: expect.stringMatching(/exited/i) as unknown as string,
      terminationReason: 'failed',
    });
    expect(session.isAlive()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:unit -- tests/unit/agent/claude-pty-session.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `PtySession`**

Create `src/agent/claude/pty-session.ts`:

```typescript
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { log } from '../../core/logger';
import type { AgentEvent } from '../types';
import { sessionJsonlPath } from './jsonl-path';
import { JsonlReader } from './jsonl-reader';
import { JsonlTurnTranslator } from './jsonl-translate';
import type { PtyHandle } from './pty';

export interface PtySessionOptions {
  pty: PtyHandle;
  cwd: string;
  sessionId: string;
  /** Override $HOME (useful for tests). */
  home?: string;
  /** JSONL poll interval (ms). Default 300. */
  pollMs?: number;
  /** Delay between prompt body and trailing CR. Default 200ms. */
  promptDelayMs?: number;
  /** Max turn duration (ms) before soft-interrupt + timeout error. */
  maxTurnMs?: number;
}

const ACCEPT_TRIGGER = 'I accept';
const ROLLING_BUFFER_BYTES = 4096;
const DEFAULT_POLL_MS = 300;
const DEFAULT_PROMPT_DELAY_MS = 200;
const DEFAULT_MAX_TURN_MS = 10 * 60 * 1000;

export class PtySession {
  private readonly jsonlPath: string;
  private readonly reader: JsonlReader;
  private rollingBuffer = '';
  private acceptPressed = false;
  private alive = true;
  private exitInfo: { exitCode: number; signal?: number } | undefined;
  private busy = false;
  private interruptRequested = false;

  constructor(private readonly opts: PtySessionOptions) {
    const home = opts.home ?? homedir();
    this.jsonlPath = sessionJsonlPath({ home, cwd: opts.cwd, sessionId: opts.sessionId });
    this.reader = new JsonlReader(this.jsonlPath);

    opts.pty.onData((s) => this.handleData(s));
    opts.pty.onExit((e) => {
      this.alive = false;
      this.exitInfo = e;
    });
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  isAlive(): boolean {
    return this.alive;
  }

  private handleData(s: string): void {
    this.rollingBuffer = (this.rollingBuffer + s).slice(-ROLLING_BUFFER_BYTES);
    if (!this.acceptPressed && this.rollingBuffer.includes(ACCEPT_TRIGGER)) {
      this.acceptPressed = true;
      this.opts.pty.write('2\r');
      log.info('agent', 'claude-bypass-accept', { sessionId: this.opts.sessionId });
    }
  }

  /**
   * Initialize the reader's cursor to the current JSONL line count. Used by
   * the pool when reusing an existing PTY for a new turn so the next turn
   * starts past whatever already lives in the log.
   */
  async syncCursorToTail(): Promise<void> {
    const { lineCount } = await this.reader.readNew();
    this.reader.setCursor(lineCount);
  }

  /**
   * Drives one turn: write prompt → poll JSONL → translate → emit events
   * until either `stop_reason: end_turn`, PTY exit, soft-interrupt resolution,
   * or watchdog timeout.
   */
  async *runTurn(prompt: string): AsyncIterable<AgentEvent> {
    if (this.busy) throw new Error('PtySession.runTurn called while previous turn is running');
    this.busy = true;
    try {
      await this.syncCursorToTail();
      const translator = new JsonlTurnTranslator();
      this.interruptRequested = false;

      this.opts.pty.write(prompt);
      await delay(this.opts.promptDelayMs ?? DEFAULT_PROMPT_DELAY_MS);
      this.opts.pty.write('\r');

      const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
      const deadline = Date.now() + (this.opts.maxTurnMs ?? DEFAULT_MAX_TURN_MS);

      while (true) {
        if (!this.alive) {
          yield {
            type: 'error',
            message: `claude PTY exited (code ${this.exitInfo?.exitCode ?? '?'}${this.exitInfo?.signal ? `, signal ${this.exitInfo.signal}` : ''})`,
            terminationReason: 'failed',
          };
          return;
        }
        const { entries } = await this.reader.readNew();
        for (const e of entries) {
          for (const ev of translator.translate(e)) {
            yield ev;
            if (ev.type === 'done') return;
          }
        }
        if (this.interruptRequested) {
          yield { type: 'done', terminationReason: 'interrupted' };
          return;
        }
        if (Date.now() > deadline) {
          this.opts.pty.write('\x1b');
          yield {
            type: 'error',
            message: 'claude turn exceeded max duration',
            terminationReason: 'timeout',
          };
          return;
        }
        await delay(pollMs);
      }
    } finally {
      this.busy = false;
    }
  }

  private interruptRequested = false;

  /**
   * Soft-interrupt: write ESC and ask the current `runTurn` loop to resolve
   * as `done(interrupted)` within `graceMs`. PTY stays alive — next turn can
   * reuse it.
   */
  async softInterrupt(graceMs = 5000): Promise<void> {
    if (!this.alive) return;
    this.opts.pty.write('\x1b');
    this.interruptRequested = true;
    await delay(graceMs);
  }

  /**
   * Hard close: SIGTERM, wait up to graceMs, SIGKILL if still alive. After
   * this call, the session is unusable and must be evicted from the pool.
   */
  async hardClose(graceMs = 3000): Promise<void> {
    if (!this.alive) return;
    this.opts.pty.kill('SIGTERM');
    const startedAt = Date.now();
    while (this.alive && Date.now() - startedAt < graceMs) {
      await delay(50);
    }
    if (this.alive) this.opts.pty.kill('SIGKILL');
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/claude-pty-session.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/pty-session.ts tests/unit/agent/claude-pty-session.test.ts
git commit -m "feat(agent): claude PtySession turn driver"
```

---

## Task 6: `ClaudePtyPool` — sessionId → `PtySession` map with idle reaper

**Files:**
- Create: `lark-coding-agent-bridge/src/agent/claude/pty-pool.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/claude-pty-pool.test.ts`

**Why:** Multiple Lark sessions concurrently → multiple PTYs. The pool
acquires (or spawns) a `PtySession` for a given `claudeSessionId`, reuses it
across turns, releases on demand, and reaps idle PTYs after a configurable
TTL (default 30 minutes).

The pool injects a `PtySessionFactory` so tests can substitute a stub
session that doesn't need real `node-pty`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent/claude-pty-pool.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { ClaudePtyPool, type PtySessionLike } from '../../../src/agent/claude/pty-pool.js';

function fakeSession(sessionId: string): PtySessionLike & { closed: boolean } {
  const s = {
    sessionId,
    cwd: '/tmp',
    closed: false,
    isAlive: () => !s.closed,
    hardClose: vi.fn(async () => {
      s.closed = true;
    }),
    softInterrupt: vi.fn(async () => {}),
    runTurn: vi.fn(),
    syncCursorToTail: vi.fn(async () => {}),
  } as unknown as PtySessionLike & { closed: boolean };
  return s;
}

describe('ClaudePtyPool', () => {
  it('spawns a new session on miss, reuses on hit', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) => {
      return fakeSession(input.sessionId ?? 'fresh-id');
    });
    const pool = new ClaudePtyPool({ factory, idleTtlMs: 60_000 });

    const a = await pool.acquire({ cwd: '/tmp', sessionId: undefined });
    expect(factory).toHaveBeenCalledTimes(1);
    const b = await pool.acquire({ cwd: '/tmp', sessionId: a.sessionId });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('release closes and forgets a session', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) =>
      fakeSession(input.sessionId ?? 'x'),
    );
    const pool = new ClaudePtyPool({ factory, idleTtlMs: 60_000 });
    const a = await pool.acquire({ cwd: '/tmp', sessionId: 'a' });

    await pool.release('a');
    expect((a as unknown as { hardClose: ReturnType<typeof vi.fn> }).hardClose).toHaveBeenCalled();

    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('reaps sessions whose last use is older than the TTL', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) =>
      fakeSession(input.sessionId ?? 'x'),
    );
    const pool = new ClaudePtyPool({
      factory,
      idleTtlMs: 5,
      sweepIntervalMs: 1,
    });
    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    await new Promise((r) => setTimeout(r, 30));
    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
    pool.stop();
  });

  it('replaces a dead session even when its id matches', async () => {
    const factory = vi.fn(async (input: { cwd: string; sessionId?: string }) =>
      fakeSession(input.sessionId ?? 'x'),
    );
    const pool = new ClaudePtyPool({ factory, idleTtlMs: 60_000 });
    const first = (await pool.acquire({ cwd: '/tmp', sessionId: 'a' })) as unknown as {
      closed: boolean;
    };
    first.closed = true;
    await pool.acquire({ cwd: '/tmp', sessionId: 'a' });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:unit -- tests/unit/agent/claude-pty-pool.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the pool**

Create `src/agent/claude/pty-pool.ts`:

```typescript
export interface PtySessionLike {
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  hardClose(graceMs?: number): Promise<void>;
}

export interface PtySessionFactoryInput {
  cwd: string;
  /** Existing claude session id to resume; undefined ⇒ assign a fresh uuid. */
  sessionId: string | undefined;
}

export type PtySessionFactory = (input: PtySessionFactoryInput) => Promise<PtySessionLike>;

export interface ClaudePtyPoolOptions {
  factory: PtySessionFactory;
  /** Idle TTL before reaper closes a session. Default 30 min. */
  idleTtlMs?: number;
  /** Sweep interval. Default 60s; tests can override. */
  sweepIntervalMs?: number;
}

interface PoolEntry {
  session: PtySessionLike;
  lastUsedAt: number;
}

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_MS = 60 * 1000;

export class ClaudePtyPool {
  private readonly bySession = new Map<string, PoolEntry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly opts: ClaudePtyPoolOptions) {
    const sweep = opts.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
    this.sweeper = setInterval(() => {
      void this.reap();
    }, sweep);
    // Don't keep the event loop alive just for the reaper.
    this.sweeper.unref?.();
  }

  /**
   * Get an existing live session by id (pool hit) or spawn a new one. Missing
   * `sessionId` always spawns fresh; the factory is expected to allocate a new
   * uuid in that case and return it via `session.sessionId`.
   */
  async acquire(input: PtySessionFactoryInput): Promise<PtySessionLike> {
    if (input.sessionId !== undefined) {
      const existing = this.bySession.get(input.sessionId);
      if (existing && existing.session.isAlive()) {
        existing.lastUsedAt = Date.now();
        return existing.session;
      }
      if (existing && !existing.session.isAlive()) {
        this.bySession.delete(input.sessionId);
      }
    }
    const session = await this.opts.factory(input);
    this.bySession.set(session.sessionId, { session, lastUsedAt: Date.now() });
    return session;
  }

  /** Bump last-used so an active turn isn't reaped mid-loop. */
  touch(sessionId: string): void {
    const entry = this.bySession.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
  }

  async release(sessionId: string): Promise<void> {
    const entry = this.bySession.get(sessionId);
    if (!entry) return;
    this.bySession.delete(sessionId);
    try {
      await entry.session.hardClose();
    } catch {
      // best-effort; the entry is already removed
    }
  }

  async closeAll(): Promise<void> {
    const entries = [...this.bySession.values()];
    this.bySession.clear();
    await Promise.all(entries.map((e) => e.session.hardClose().catch(() => undefined)));
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  private async reap(): Promise<void> {
    const ttl = this.opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, entry] of this.bySession) {
      if (!entry.session.isAlive() || now - entry.lastUsedAt > ttl) {
        stale.push(id);
      }
    }
    for (const id of stale) {
      await this.release(id);
    }
  }
}
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/claude-pty-pool.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude/pty-pool.ts tests/unit/agent/claude-pty-pool.test.ts
git commit -m "feat(agent): ClaudePtyPool with idle reaper"
```

---

## Task 7: Add optional `closeSession` to `AgentAdapter` interface

**Files:**
- Modify: `lark-coding-agent-bridge/src/agent/types.ts`
- Test: `lark-coding-agent-bridge/tests/unit/agent/types-contract.test.ts`

**Why:** Bridge needs a way to tell the adapter that a Lark session is gone
(`/new`, `/cd`, `/reset`, `/resume`). Optional so existing Codex adapter
needs no change.

- [ ] **Step 1: Update the interface**

Edit `src/agent/types.ts`, adding to `AgentAdapter`:

```typescript
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
  /**
   * Bridge hook called when a Lark session's persisted state is cleared
   * (`/new`, `/cd`, `/reset`, `/resume` to a different id). Adapters that
   * own per-session resources (e.g., long-lived PTYs) should free them.
   * `sessionId` is the previously-active claude session id.
   */
  closeSession?(sessionId: string): Promise<void>;
}
```

- [ ] **Step 2: Extend `types-contract.test.ts` to cover `closeSession` optionality**

Open `tests/unit/agent/types-contract.test.ts` and append a test that creates
a minimal adapter without `closeSession` and a minimal adapter with one, and
verifies both type-check (this test exists to lock the optional shape):

```typescript
import { describe, it } from 'vitest';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';

describe('AgentAdapter.closeSession', () => {
  it('is optional on the interface', () => {
    const minimal: AgentAdapter = {
      id: 'x',
      displayName: 'X',
      async isAvailable() { return true; },
      run(_: AgentRunOptions): AgentRun {
        return {
          runId: 'r',
          events: (async function* () {})(),
          async stop() {},
          async waitForExit() { return true; },
        };
      },
    };
    const withClose: AgentAdapter = {
      ...minimal,
      async closeSession() {},
    };
    void minimal;
    void withClose;
  });
});
```

- [ ] **Step 3: Run tests + typecheck, confirm pass**

```bash
pnpm test:unit -- tests/unit/agent/types-contract.test.ts
pnpm typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add src/agent/types.ts tests/unit/agent/types-contract.test.ts
git commit -m "feat(agent): optional closeSession on AgentAdapter"
```

---

## Task 8: Rewrite `ClaudeAdapter` to use the PTY pool

**Files:**
- Modify: `lark-coding-agent-bridge/src/agent/claude/adapter.ts`
- Delete: `lark-coding-agent-bridge/src/agent/claude/stream-json.ts`
- Delete: `lark-coding-agent-bridge/tests/unit/agent/claude-stream-json.test.ts`
- Delete: `lark-coding-agent-bridge/tests/process/claude-adapter.test.ts`
- Create: `lark-coding-agent-bridge/tests/integration/claude/pty-adapter.test.ts`
- Create: `lark-coding-agent-bridge/tests/fixtures/claude-fake/claude.mjs`

**Why:** This is the swap. The new adapter:
1. Owns a `ClaudePtyPool`.
2. `run(opts)` acquires (or spawns) a `PtySession`, returns an `AgentRun`
   whose `events` come from `session.runTurn(prompt)`.
3. `closeSession(id)` calls `pool.release(id)`.

The old `claude -p` adapter and its tests go away — they tested behavior
that no longer exists.

- [ ] **Step 1: Add a scriptable fake claude binary fixture**

Create `tests/fixtures/claude-fake/claude.mjs`:

```javascript
#!/usr/bin/env node
// Fake `claude` TUI used by integration tests.
//
// Flags consumed: --session-id, --resume, --permission-mode,
//   --append-system-prompt, --model.
// Behavior is scripted via env:
//   FAKE_CLAUDE_BANNER=1 → print "Yes, I accept" startup banner
//   FAKE_CLAUDE_TURNS_JSON=<json array of arrays of entries>
//     For each prompt read on stdin, append the next array's entries to the
//     session JSONL file (one entry per line).
//   FAKE_CLAUDE_EXIT_AFTER=<n> → exit cleanly after n turns
//   FAKE_CLAUDE_CRASH_AFTER=<n> → exit 1 after n turns
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionId = arg('--session-id') ?? arg('--resume');
const cwd = process.cwd();
const encoded = cwd.replace(/\//g, '-').replace(/^-?/, '-');
const jsonl = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
mkdirSync(dirname(jsonl), { recursive: true });
if (!existsSync(jsonl)) writeFileSync(jsonl, '');

if (process.env.FAKE_CLAUDE_BANNER) {
  process.stdout.write('Bypass Permissions mode\n  1. No\n  2. Yes, I accept\n');
}

const turns = JSON.parse(process.env.FAKE_CLAUDE_TURNS_JSON ?? '[]');
const exitAfter = Number(process.env.FAKE_CLAUDE_EXIT_AFTER ?? -1);
const crashAfter = Number(process.env.FAKE_CLAUDE_CRASH_AFTER ?? -1);

let turnIdx = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {
  const entries = turns[turnIdx] ?? [
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '(fake)' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
  for (const e of entries) appendFileSync(jsonl, JSON.stringify(e) + '\n');
  turnIdx += 1;
  if (crashAfter >= 0 && turnIdx >= crashAfter) process.exit(1);
  if (exitAfter >= 0 && turnIdx >= exitAfter) process.exit(0);
});
```

```bash
chmod +x tests/fixtures/claude-fake/claude.mjs
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/claude/pty-adapter.test.ts`:

```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import type { AgentEvent } from '../../../src/agent/types.js';

const fakeBinary = fileURLToPath(new URL('../../fixtures/claude-fake/claude.mjs', import.meta.url));

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('ClaudeAdapter (PTY)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('runs a fresh turn end-to-end, reuses the PTY across two turns of the same session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-pty-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'claude-pty-cwd-'));
    dirs.push(home, cwd);

    const turns = [
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
      ],
    ];

    const adapter = new ClaudeAdapter({
      binary: fakeBinary,
      homeOverride: home,
      env: { FAKE_CLAUDE_TURNS_JSON: JSON.stringify(turns) },
    });

    const r1 = adapter.run({ runId: 'r1', prompt: 'hi', cwd });
    const e1 = await collect(r1.events);
    expect(e1.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'a' });
    const sessionId = (e1.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();

    const r2 = adapter.run({ runId: 'r2', prompt: 'again', cwd, sessionId });
    const e2 = await collect(r2.events);
    expect(e2.find((e) => e.type === 'text')).toEqual({ type: 'text', delta: 'b' });

    await adapter.closeSession?.(sessionId!);
  });

  it('closeSession releases the session so a follow-up acquires a fresh one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-pty-home-'));
    const cwd = await mkdtemp(join(tmpdir(), 'claude-pty-cwd-'));
    dirs.push(home, cwd);

    const adapter = new ClaudeAdapter({
      binary: fakeBinary,
      homeOverride: home,
      env: { FAKE_CLAUDE_TURNS_JSON: JSON.stringify([
        [{ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }], stop_reason: 'end_turn', usage: {} } }],
      ]) },
    });

    const r = adapter.run({ runId: 'r', prompt: 'hi', cwd });
    const events = await collect(r.events);
    const id = (events.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId!;
    await adapter.closeSession?.(id);

    // A fresh run with the same (now-released) id falls back to a new spawn.
    const r2 = adapter.run({ runId: 'r2', prompt: 'fresh', cwd, sessionId: id });
    const e2 = await collect(r2.events);
    expect((e2.find((e) => e.type === 'system') as { sessionId?: string } | undefined)?.sessionId).not.toBe(id);
  });
});
```

- [ ] **Step 3: Delete the obsolete tests and old adapter source**

```bash
git rm src/agent/claude/stream-json.ts \
       tests/unit/agent/claude-stream-json.test.ts \
       tests/process/claude-adapter.test.ts
```

- [ ] **Step 4: Rewrite `src/agent/claude/adapter.ts`**

Replace the file with:

```typescript
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { log } from '../../core/logger';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { sessionJsonlPath } from './jsonl-path';
import { PtySession } from './pty-session';
import { ClaudePtyPool, type PtySessionLike } from './pty-pool';
import { spawnPty } from './pty';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** Test-only: override $HOME for the JSONL path. */
  homeOverride?: string;
  /** Test-only: extra env to pass into the spawned claude. */
  env?: Record<string, string>;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly homeOverride: string | undefined;
  private readonly extraEnv: Record<string, string>;
  private botIdentity: AgentBotIdentity | undefined;
  private readonly pool: ClaudePtyPool;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
    this.homeOverride = opts.homeOverride;
    this.extraEnv = opts.env ?? {};
    this.pool = new ClaudePtyPool({
      factory: (input) => this.spawnSession(input.cwd, input.sessionId),
    });
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.pool.release(sessionId);
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for ClaudeAdapter.run');
    const cwd = opts.cwd;
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    let session: PtySession | undefined;
    let acquired: Promise<PtySession> | undefined;
    let acquiredId: string | undefined;
    const acquire = (): Promise<PtySession> => {
      if (!acquired) {
        acquired = this.pool
          .acquire({ cwd, sessionId: opts.sessionId })
          .then((s) => {
            session = s as PtySession;
            acquiredId = session.sessionId;
            return session;
          });
      }
      return acquired;
    };

    const events = (async function* (
      adapter: ClaudeAdapter,
    ): AsyncGenerator<AgentEvent> {
      let s: PtySession;
      try {
        s = await acquire();
      } catch (err) {
        yield {
          type: 'error',
          message: `failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`,
          terminationReason: 'failed',
        };
        return;
      }
      // Fresh session: surface the assigned sessionId so the bridge can persist it.
      if (!opts.sessionId) {
        yield { type: 'system', sessionId: s.sessionId, cwd: s.cwd };
      }
      try {
        for await (const ev of s.runTurn(opts.prompt)) {
          yield ev;
          if (ev.type === 'error' && ev.terminationReason === 'failed') {
            await adapter.pool.release(s.sessionId);
            return;
          }
        }
      } finally {
        if (acquiredId) adapter.pool.touch(acquiredId);
      }
    })(this);

    return {
      runId: opts.runId,
      events,
      async stop() {
        if (!session) {
          try { session = await acquire(); } catch { return; }
        }
        await session.softInterrupt(stopGraceMs);
      },
      async waitForExit(_timeoutMs: number): Promise<boolean> {
        // PTY world: "exit" === "current turn done". The caller already
        // drained events before reaching here, so the turn is by definition
        // complete; the PTY itself is meant to stay alive.
        return true;
      },
    };
  }

  private async spawnSession(cwd: string, sessionIdHint: string | undefined): Promise<PtySessionLike> {
    const sessionId = sessionIdHint ?? randomUUID();
    const resume = sessionIdHint !== undefined && existsSync(
      sessionJsonlPath({ home: this.homeOverride ?? homedir(), cwd, sessionId }),
    );

    const args = [
      '--permission-mode', CLAUDE_DEFAULT_PERMISSION_MODE,
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
      '--append-system-prompt', buildBridgeSystemPrompt(this.botIdentity),
    ];

    log.info('agent', 'claude-pty-spawn', { sessionId, cwd, resume });

    const env = {
      ...process.env,
      ...buildLarkChannelEnv(this.larkChannel),
      ...this.extraEnv,
    } as Record<string, string | undefined>;

    const pty = spawnPty({ file: this.binary, args, cwd, env });
    return new PtySession({
      pty,
      cwd,
      sessionId,
      ...(this.homeOverride ? { home: this.homeOverride } : {}),
    });
  }
}
```

- [ ] **Step 5: Run integration tests, confirm pass**

```bash
pnpm test:integration -- tests/integration/claude/pty-adapter.test.ts
pnpm typecheck
```

Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(agent): rewrite ClaudeAdapter on top of pty pool + jsonl"
```

---

## Task 9: Wire `closeSession` into the bridge's session-reset paths

**Files:**
- Modify: `lark-coding-agent-bridge/src/commands/index.ts`
- Test: `lark-coding-agent-bridge/tests/integration/commands/close-session.test.ts`

**Why:** `/new`, `/reset`, `/cd` all call `ctx.sessions.clear(scope)`. We
need to also tell the adapter to release the PTY tied to the old session id,
otherwise the pool would accumulate orphans until the reaper fires.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/commands/close-session.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
// Adjust imports to match the project's test harness. This sketch shows the
// shape; the engineer should align with neighbours in tests/integration/commands.
import { handleNew, handleCd } from '../../../src/commands/index.js';

describe('slash command session reset', () => {
  it('handleNew calls adapter.closeSession with the previously stored sessionId', async () => {
    const closeSession = vi.fn(async () => {});
    const ctx = makeFakeCtx({ sessionId: 'sess-A', closeSession });
    await handleNew('', ctx);
    expect(closeSession).toHaveBeenCalledWith('sess-A');
  });

  it('handleCd calls adapter.closeSession with the previously stored sessionId', async () => {
    const closeSession = vi.fn(async () => {});
    const ctx = makeFakeCtx({ sessionId: 'sess-B', closeSession });
    await handleCd(process.cwd(), ctx);
    expect(closeSession).toHaveBeenCalledWith('sess-B');
  });

  it('handleNew skips closeSession when no sessionId was stored', async () => {
    const closeSession = vi.fn(async () => {});
    const ctx = makeFakeCtx({ sessionId: undefined, closeSession });
    await handleNew('', ctx);
    expect(closeSession).not.toHaveBeenCalled();
  });
});

function makeFakeCtx(input: { sessionId: string | undefined; closeSession: (id: string) => Promise<void> }): any {
  return {
    scope: 'chat-1',
    activeRuns: { interrupt: () => true },
    sessions: {
      getRaw: () => (input.sessionId ? { sessionId: input.sessionId, cwd: process.cwd() } : undefined),
      clear: () => {},
    },
    sessionCatalog: undefined,
    sessionCatalogIdentity: undefined,
    workspaces: { setCwd: () => {} },
    agent: { id: 'claude', displayName: 'Claude Code', closeSession: input.closeSession },
    msg: { senderId: 'x' },
    channel: { send: async () => {} },
    reply: async () => {},
  };
}
```

> **Engineer note:** the test sketch above is intentionally minimal — adapt
> the ctx shape to match how the surrounding command tests construct theirs.
> The behavior under test is: before `sessions.clear`, look at the previous
> `sessionId` and (if present and `agent.closeSession` exists) call it.

- [ ] **Step 2: Run test, confirm failure**

```bash
pnpm test:integration -- tests/integration/commands/close-session.test.ts
```

Expected: FAIL — `closeSession` is never called by the existing handlers.

- [ ] **Step 3: Implement the hook in `src/commands/index.ts`**

Add a helper near the top of the file (after imports) and call it from
`handleNew` and `handleCd` before `ctx.sessions.clear(...)`:

```typescript
async function releasePreviousClaudeSession(ctx: CommandContext, scope: string): Promise<void> {
  const prev = ctx.sessions.getRaw(scope);
  const prevId = prev?.sessionId;
  if (!prevId) return;
  const close = ctx.agent.closeSession;
  if (!close) return;
  try {
    await close.call(ctx.agent, prevId);
  } catch (err) {
    log.warn('command', 'close-session-failed', {
      scope,
      sessionId: prevId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
```

Then in `handleNew`, immediately before `ctx.sessions.clear(ctx.scope);`:

```typescript
  await releasePreviousClaudeSession(ctx, ctx.scope);
  ctx.sessions.clear(ctx.scope);
```

And in `handleCd`, immediately before `ctx.sessions.clear(ctx.scope);`:

```typescript
  await releasePreviousClaudeSession(ctx, ctx.scope);
  ctx.sessions.clear(ctx.scope);
```

- [ ] **Step 4: Run test, confirm pass**

```bash
pnpm test:integration -- tests/integration/commands/close-session.test.ts
pnpm typecheck
```

Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 5: Search for any other `ctx.sessions.clear(...)` call sites and add the same hook**

```bash
grep -n "sessions\.clear(" src/commands/index.ts
```

For every match other than the two already updated, prepend
`await releasePreviousClaudeSession(ctx, ctx.scope);`. (As of writing there is
one third site at the `/resume` mismatch path; verify in code and apply the
same fix.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/index.ts tests/integration/commands/close-session.test.ts
git commit -m "feat(bot): release claude PTY on /new, /cd, /reset"
```

---

## Task 10: Update README, run full local CI, smoke-test

**Files:**
- Modify: `lark-coding-agent-bridge/README.md`
- Modify: `lark-coding-agent-bridge/README.zh.md`

- [ ] **Step 1: Document the new claude session model in the README**

In both README files, add a small section under "Working directories":

```markdown
### How Claude sessions are persisted

The Claude adapter now keeps one long-lived `claude` TUI session per Lark
conversation, driven via a PTY. Conversation logs land at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (the standard
location `claude` already uses interactively). `/new`, `/cd`, and `/reset`
close the matching PTY; idle PTYs are reaped after 30 minutes.
```

- [ ] **Step 2: Run the full local CI**

```bash
pnpm ci:local
```

Expected: all green (unit + integration + typecheck + build, git diff clean).

- [ ] **Step 3: Smoke-test end-to-end against a real Lark app**

Start the bridge in a scratch profile:

```bash
node ./bin/lark-channel-bridge.mjs run --profile claude-pty-smoke
```

Send the following sequence to the bot in a DM and verify each works:

1. `hello` — fresh PTY spawn, response streams to the card.
2. `what's 2+2` — same PTY reused (look for `claude-pty-spawn` log entry only once).
3. `/cd /tmp` — PTY closed, next message starts a new one in `/tmp`.
4. Send a long task, then `/stop` mid-turn — turn ends as interrupted, but
   the next message reuses the same PTY (verify by checking
   `claude-pty-spawn` count in logs).
5. `/new` — PTY closed.
6. `/resume` after several turns — adapter spawns with `--resume`.

Expected: streaming card updates feel as smooth as before; logs show PTYs
are reused between turns and only torn down on `/new`, `/cd`, hard failure,
or idle reap.

- [ ] **Step 4: Commit README updates**

```bash
git add README.md README.zh.md
git commit -m "docs: describe claude PTY session model"
```

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/claude-pty-bridge
gh pr create --title "feat(claude): replace claude -p with persistent PTY + JSONL adapter" --body "$(cat <<'EOF'
## Summary
- Drops dependency on the removed `claude -p` mode.
- New PTY-based ClaudeAdapter with one long-lived `claude` per Lark session;
  output streams from `~/.claude/projects/<encoded>/<id>.jsonl`.
- Drops Windows from the Claude CI matrix; Codex path is unchanged.

## Test plan
- [x] pnpm ci:local
- [x] Smoke: fresh turn → reuse turn → /cd → /stop mid-turn → /new → /resume
- [x] node-pty native build verified on macOS + Linux
EOF
)"
```

---

## Self-review checklist (run after writing all tasks above)

- [ ] **Spec coverage** — every item in §Files of the spec maps to a task:
  - `adapter.ts` rewrite → Task 8
  - `pty-session.ts` → Task 5
  - `pty-pool.ts` → Task 6
  - `jsonl-reader.ts` → Task 2
  - `jsonl-translate.ts` → Task 3
  - `stream-json.ts` deletion → Task 8
  - `types.ts` `closeSession` patch → Task 7
  - `preflight.ts` patch → no change required (verified: file already does
    `--version` only)
  - `bot/channel.ts` / `commands/*` reset hook → Task 9
  - `package.json` + CI patch + Windows drop → Task 0
  - Test fixtures + integration tests → Tasks 5, 8
- [ ] **Placeholder scan** — none. Every code block is concrete.
- [ ] **Type consistency** — `PtySessionLike` is defined in Task 6 and `PtySession`
  (Task 5) is shape-compatible (sessionId/cwd/isAlive/hardClose). `ClaudePtyPool`
  imports `PtySessionLike`. Adapter (Task 8) returns `PtySessionLike` from
  factory but casts to `PtySession` internally to access `softInterrupt`/`runTurn` —
  acceptable because adapter constructed both.
- [ ] **Open follow-ups** — Codex Windows still supported via its existing
  process model; documented in PR body that only the Claude path drops Windows.
