# Compact 卡片模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 compact 卡片模式——运行中只显示一行状态 + 终止按钮；结束后显示轻量 LLM 生成的一句话排查结论 + 折叠的完整详情。

**Architecture:** 三态偏好 `cardStyle: auto|streaming|compact`（auto 默认：群/话题群→compact，p2p→streaming）。compact 解析生效时强制走交互卡片管线（`renderCard`），因为折叠面板只有交互卡片支持；streaming 维持现有 `messageReply` 行为。`RunState` 累积逻辑不动，`renderCard` 加 compact 分支。总结由独立一次性 `claude -p --model haiku` 子进程生成，15s 超时兜底取首句，不占 run 池。

**Tech Stack:** TypeScript, vitest（快照测试）, 飞书 CardKit 2.0 collapsible_panel, cross-spawn。

**Spec:** `docs/superpowers/specs/2026-07-18-compact-card-design.md`

**重要背景（实现者必读）：**

- 当前默认回复模式是 `messageReply: 'markdown'`（`renderText` 流式 markdown 卡片，无面板）；带折叠面板的 `renderCard` 管线只在 `messageReply: 'card'` 时走，且该选项已从 /config 表单隐藏。**compact 必须用 `renderCard` 管线**，所以 channel.ts 里 compact 生效时用它覆盖 replyMode。
- 测试跑法：`npx vitest run <path>`（仓库根目录）。快照测试用 `tests/helpers/card-normalize.js` 的 `normalizeCard`。
- 所有 import 在 src 内部不带 `.js` 后缀（源码风格），tests 内 import src 要带 `.js` 后缀（现有测试如此）。

---

### Task 1: 配置 — `cardStyle` 偏好 + 解析函数

**Files:**
- Modify: `src/config/schema.ts`（`AppPreferences` ~L146 前、文件尾部 resolver 区）
- Test: `tests/unit/config/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

在 `tests/unit/config/schema.test.ts` 追加（import 区补 `resolveCardStyle, getCardStylePref`；测试文件里已有构造 `AppConfig` 的现成模式，复用其 `cfg` 工厂/字面量写法）：

```ts
import { resolveCardStyle, getCardStylePref } from '../../../src/config/schema.js';

describe('cardStyle preference', () => {
  const base = {
    accounts: { app: { id: 'a', secret: 's', tenant: 't' } },
  } as AppConfig;
  const withStyle = (v: unknown): AppConfig =>
    ({ ...base, preferences: { cardStyle: v } }) as AppConfig;

  it('defaults to auto: p2p → streaming, group/topic → compact', () => {
    expect(resolveCardStyle(base, 'p2p')).toBe('streaming');
    expect(resolveCardStyle(base, 'group')).toBe('compact');
    expect(resolveCardStyle(base, 'topic')).toBe('compact');
  });

  it('explicit streaming/compact applies to every chat mode', () => {
    for (const mode of ['p2p', 'group', 'topic'] as const) {
      expect(resolveCardStyle(withStyle('streaming'), mode)).toBe('streaming');
      expect(resolveCardStyle(withStyle('compact'), mode)).toBe('compact');
    }
  });

  it('unknown values fall back to auto behavior', () => {
    expect(resolveCardStyle(withStyle('bogus'), 'p2p')).toBe('streaming');
    expect(resolveCardStyle(withStyle('bogus'), 'group')).toBe('compact');
  });

  it('getCardStylePref returns the raw 3-state with auto default', () => {
    expect(getCardStylePref(base)).toBe('auto');
    expect(getCardStylePref(withStyle('compact'))).toBe('compact');
    expect(getCardStylePref(withStyle('bogus'))).toBe('auto');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/config/schema.test.ts`
Expected: FAIL —— `resolveCardStyle` 未导出。

- [ ] **Step 3: Implement**

`src/config/schema.ts`，`AppPreferences` 里 `agentStopGraceMs` 之后加字段：

```ts
  /**
   * 卡片呈现风格。`auto`（默认）：群/话题群用 compact（运行中只显示状态行，
   * 结束后一句话结论 + 折叠详情），p2p 保持 streaming（现状）。
   * `streaming` / `compact` 对所有聊天强制统一。
   * compact 生效时强制走交互卡片管线（messageReply 被覆盖为 card 行为），
   * 因为折叠面板只有交互卡片支持。
   */
  cardStyle?: CardStyle;
```

文件顶部类型区（`MessageReplyMode` 附近）加：

```ts
export type CardStyle = 'auto' | 'streaming' | 'compact';
export type ResolvedCardStyle = 'streaming' | 'compact';
```

文件尾部 resolver 区（`getRunIdleTimeoutMs` 之后）加：

```ts
/** Raw 3-state cardStyle preference, default 'auto'. For the /config form. */
export function getCardStylePref(cfg: AppConfig): CardStyle {
  const raw = cfg.preferences?.cardStyle;
  return raw === 'streaming' || raw === 'compact' || raw === 'auto' ? raw : 'auto';
}

/**
 * Resolve the effective card style for one chat. `auto` maps group & topic
 * chats to compact (business-triage groups want conclusion-first cards) and
 * p2p to streaming (watching the run live is useful in 1:1).
 */
export function resolveCardStyle(
  cfg: AppConfig,
  chatMode: 'p2p' | 'group' | 'topic',
): ResolvedCardStyle {
  const raw = getCardStylePref(cfg);
  if (raw === 'streaming' || raw === 'compact') return raw;
  return chatMode === 'p2p' ? 'streaming' : 'compact';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/config/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/unit/config/schema.test.ts
git commit -m "feat(config): add cardStyle preference with auto/streaming/compact"
```

---

### Task 2: 渲染 — `renderCard` compact 分支

**Files:**
- Modify: `src/card/run-renderer.ts`
- Test: `tests/unit/card/run-renderer.compact.test.ts`（新建）

**渲染规则（与 spec 对应）：**

- running：只输出一行状态（最近一个 running 工具的 `toolHeaderText`；无工具时按 footer 显示 `🧠 正在思考…` / `✍️ 正在输出…`）+ 终止按钮。
- done 且正文非空：
  - 正文 < 100 字符 → 正文直接平铺，不折叠、不要总结。
  - 否则 → 顶部一行：`options.summary`（无则 `⏳ 正在生成总结…` 占位），下面依次：`▸ 查看详情` 折叠面板（完整正文，截 20000 字符）、思考折叠面板（如有，复用 `reasoningPanel` 折叠态）、工具折叠汇总（如有，复用 `collapsedToolSummary`）。面板之间是兄弟元素——**不嵌套** collapsible_panel（飞书嵌套支持不可靠）。
- done 且正文为空：沿用 `_（未返回内容）_`，工具/思考面板照常跟随。
- interrupted / idle_timeout / error：沿用现有状态行文案，**不出总结**，详情面板照常跟随（有正文才有详情面板）。

- [ ] **Step 1: Write the failing tests**

新建 `tests/unit/card/run-renderer.compact.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  finalReplyText,
  renderCard,
  SHORT_REPLY_MAX,
} from '../../../src/card/run-renderer.js';
import {
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

const LONG_TEXT = '库存扣减失败的排查过程如下。'.repeat(20); // > SHORT_REPLY_MAX

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

function compact(state: RunState, summary?: string): unknown {
  return normalizeCard(renderCard(state, { style: 'compact', summary }));
}

describe('compact card renderer', () => {
  it('running with no tool shows thinking status + stop button only', () => {
    expect(compact(initialState)).toMatchSnapshot();
    expect(
      compact(stateFrom([{ type: 'thinking', delta: 'looking at logs' }])),
    ).toMatchSnapshot();
  });

  it('running with an active tool shows that tool header line', () => {
    expect(
      compact(
        stateFrom([
          { type: 'text', delta: 'preface' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        ]),
      ),
    ).toMatchSnapshot();
  });

  it('done with long text shows summary placeholder then real summary', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'root cause hunt' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep err' } },
      { type: 'tool_result', id: 't1', output: 'found', isError: false },
      { type: 'text', delta: LONG_TEXT },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(compact(state)).toMatchSnapshot(); // ⏳ 占位
    expect(compact(state, '扣减失败是 sync_status 未回写导致')).toMatchSnapshot();
  });

  it('done with short text renders it inline without summary or detail', () => {
    const state = stateFrom([
      { type: 'text', delta: '是的，该接口幂等。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(compact(state)).toMatchSnapshot();
  });

  it('abnormal endings keep status line and skip the summary', () => {
    expect(
      compact(markInterrupted(stateFrom([{ type: 'text', delta: LONG_TEXT }]))),
    ).toMatchSnapshot();
    expect(
      compact(
        stateFrom([
          { type: 'error', message: 'process failed', terminationReason: 'failed' },
        ]),
      ),
    ).toMatchSnapshot();
  });

  it('finalReplyText concatenates text blocks only', () => {
    const state = stateFrom([
      { type: 'text', delta: 'part one' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_result', id: 't1', output: 'x', isError: false },
      { type: 'text', delta: 'part two' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(finalReplyText(state)).toBe('part one\npart two');
    expect(SHORT_REPLY_MAX).toBe(100);
  });

  it('streaming style output is unchanged (no style option = current card)', () => {
    const state = stateFrom([
      { type: 'text', delta: 'answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(normalizeCard(renderCard(state))).toEqual(
      normalizeCard(renderCard(state, { style: 'streaming' })),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/card/run-renderer.compact.test.ts`
Expected: FAIL —— `finalReplyText` / `SHORT_REPLY_MAX` 未导出。

- [ ] **Step 3: Implement**

`src/card/run-renderer.ts` 修改：

顶部常量区加：

```ts
const DETAIL_MAX = 20_000;
export const SHORT_REPLY_MAX = 100;
```

`RunCardRenderOptions` 扩展：

```ts
export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  /** 'compact' 启用「状态栏 + 结论 + 折叠详情」渲染；缺省/'streaming' 走现有渲染。 */
  style?: 'streaming' | 'compact';
  /** compact 专用：结束后的一句话结论。undefined = 总结生成中（显示 ⏳ 占位）。 */
  summary?: string;
}
```

`renderCard` 开头加分流：

```ts
export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  if (options.style === 'compact') return renderCompactCard(state, options);
  // ……以下原有逻辑不动
```

文件中部（`groupBlocks` 之前）加：

```ts
/** All text-block content joined — the agent's final reply, tools excluded. */
export function finalReplyText(state: RunState): string {
  return state.blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content)
    .join('\n')
    .trim();
}

function renderCompactCard(state: RunState, options: RunCardRenderOptions): object {
  const elements: object[] = [];

  if (state.terminal === 'running') {
    elements.push(noteMd(compactStatusLine(state)));
    elements.push(stopButton(options));
    return compactShell(state, elements);
  }

  const text = finalReplyText(state);

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done') {
    if (!text) {
      elements.push(noteMd('_（未返回内容）_'));
    } else if (text.length < SHORT_REPLY_MAX) {
      // 一句话回复直接平铺——不折叠、不总结，避免多一次点击。
      elements.push(markdown(text));
      return compactShell(state, elements);
    } else {
      elements.push(markdown(options.summary ?? '⏳ 正在生成总结…'));
    }
  }

  if (text && (state.terminal !== 'done' || text.length >= SHORT_REPLY_MAX)) {
    elements.push(
      collapsiblePanel({
        title: '📄 **查看详情**',
        expanded: false,
        border: 'blue',
        body: truncate(text, DETAIL_MAX),
      }),
    );
  }
  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, false));
  }
  const tools = state.blocks.filter(
    (b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool',
  );
  if (tools.length > 0) {
    elements.push(collapsedToolSummary(tools.map((b) => b.tool), true));
  }
  return compactShell(state, elements);
}

function compactStatusLine(state: RunState): string {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b && b.kind === 'tool' && b.tool.status === 'running') {
      return toolHeaderText(b.tool);
    }
  }
  if (state.footer === 'streaming') return '✍️ 正在输出…';
  return '🧠 正在思考…';
}

function compactShell(state: RunState, elements: object[]): object {
  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}
```

注意：需要在文件顶部 import `Block` 类型（`import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';` —— `Block` 是新增的）。

- [ ] **Step 4: Run tests（新旧都要过）**

Run: `npx vitest run tests/unit/card/`
Expected: PASS（compact 新快照生成；`run-renderer.snapshot.test.ts` 旧快照不变——若旧快照有 diff 说明改坏了 streaming 路径，必须修复而不是更新快照）。

- [ ] **Step 5: 人工检查生成的快照**

打开 `tests/unit/card/__snapshots__/run-renderer.compact.test.ts.snap`，确认：running 态只有一行状态 + 按钮；done 长文本态首元素是 ⏳ 或总结文本；面板是兄弟关系无嵌套。

- [ ] **Step 6: Commit**

```bash
git add src/card/run-renderer.ts tests/unit/card/
git commit -m "feat(card): compact render branch — status line while running, summary + collapsed detail when done"
```

---

### Task 3: 总结生成 — `summarizeReply`

**Files:**
- Create: `src/agent/summarize.ts`
- Test: `tests/unit/agent/summarize.test.ts`（新建；目录不存在则创建）

- [ ] **Step 1: Write the failing tests**

新建 `tests/unit/agent/summarize.test.ts`。用注入的 fake spawn 模拟子进程（EventEmitter + PassThrough），不真正起进程：

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { fallbackSummary, summarizeReply } from '../../../src/agent/summarize.js';

interface FakeChildScript {
  stdout?: string;
  exitCode?: number;
  /** 永不退出（用来触发超时）。 */
  hang?: boolean;
  /** 触发 spawn error 事件。 */
  spawnError?: string;
}

function fakeSpawn(script: FakeChildScript) {
  const calls: { command: string; args: string[]; stdin: string }[] = [];
  const spawn = (command: string, args: readonly string[] = []) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stdin: PassThrough;
      killed: boolean;
      kill: (sig?: string) => void;
    };
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    let stdinBuf = '';
    child.stdin.on('data', (d) => {
      stdinBuf += String(d);
    });
    const call = { command, args: [...args], stdin: '' };
    calls.push(call);
    setImmediate(() => {
      call.stdin = stdinBuf;
      if (script.spawnError) {
        child.emit('error', new Error(script.spawnError));
        return;
      }
      if (script.hang) return;
      if (script.stdout) child.stdout.write(script.stdout);
      child.stdout.end();
      child.emit('close', script.exitCode ?? 0);
    });
    return child;
  };
  return { spawn: spawn as never, calls };
}

const LONG_REPLY = `扣减失败的根因是 sync_status 未回写。\n后续段落。${'x'.repeat(200)}`;

describe('summarizeReply', () => {
  it('returns trimmed model output and passes model/prompt/stdin', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: '  根因是 sync_status 未回写。\n' });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('根因是 sync_status 未回写。');
    expect(calls[0]?.command).toBe('claude');
    expect(calls[0]?.args).toContain('--model');
    expect(calls[0]?.args).toContain('haiku');
    expect(calls[0]?.stdin).toContain('sync_status');
  });

  it('falls back to first line on non-zero exit', async () => {
    const { spawn } = fakeSpawn({ stdout: 'partial', exitCode: 1 });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });

  it('falls back on empty output', async () => {
    const { spawn } = fakeSpawn({ stdout: '   \n' });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });

  it('falls back on spawn error', async () => {
    const { spawn } = fakeSpawn({ spawnError: 'ENOENT' });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });

  it('kills the child and falls back on timeout', async () => {
    const { spawn } = fakeSpawn({ hang: true });
    const out = await summarizeReply(LONG_REPLY, { spawn, timeoutMs: 30 });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });
});

describe('fallbackSummary', () => {
  it('takes the first non-empty line, capped at 80 chars', () => {
    expect(fallbackSummary('\n\n  第一行结论  \n第二行')).toBe('第一行结论');
    const long = 'a'.repeat(120);
    expect(fallbackSummary(long)).toBe(`${'a'.repeat(80)}…`);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/agent/summarize.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: Implement**

新建 `src/agent/summarize.ts`：

```ts
import type { ChildProcess } from 'node:child_process';
import { log } from '../core/logger';
import { spawnProcess } from '../platform/spawn';

/**
 * One-shot summary of an agent's final reply, for the compact card header.
 * Runs `claude -p <prompt> --model haiku` with the reply on stdin — a plain
 * subprocess, deliberately outside the run pool / session machinery: it
 * must never consume a concurrency slot or touch session state, and its
 * failure only degrades the card (fallback = first line), never the run.
 */
export interface SummarizeOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  spawn?: typeof spawnProcess;
}

const SUMMARY_PROMPT =
  '下面是一个 AI agent 对业务/技术问题的完整回复。' +
  '用一到两句话给出核心结论——突出原因和结果，面向在群里扫一眼消息的读者。' +
  '不要过程描述，不要开场白，不要 emoji，不要 markdown 标题，直接输出结论文本。';
const INPUT_MAX = 30_000;
const FALLBACK_MAX = 80;

/** First non-empty line, capped — used whenever the model call fails. */
export function fallbackSummary(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return firstLine.length > FALLBACK_MAX
    ? `${firstLine.slice(0, FALLBACK_MAX)}…`
    : firstLine;
}

export async function summarizeReply(
  text: string,
  opts: SummarizeOptions = {},
): Promise<string> {
  const binary = opts.binary ?? 'claude';
  const model = opts.model ?? 'haiku';
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const spawn = opts.spawn ?? spawnProcess;
  const input = text.length > INPUT_MAX ? text.slice(0, INPUT_MAX) : text;
  try {
    const raw = await runOnce(
      spawn,
      binary,
      ['-p', SUMMARY_PROMPT, '--model', model],
      input,
      timeoutMs,
    );
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
    log.warn('summarize', 'empty-output', { model });
  } catch (err) {
    log.warn('summarize', 'failed', { model, err: String(err) });
  }
  return fallbackSummary(text);
}

function runOnce(
  spawn: typeof spawnProcess,
  binary: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error(`summarize timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer | string) => {
      out += String(d);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) =>
      settle(() => {
        if (code === 0) resolve(out);
        else reject(new Error(`summarize exited with code ${code}`));
      }),
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/agent/summarize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/summarize.ts tests/unit/agent/summarize.test.ts
git commit -m "feat(agent): one-shot haiku reply summarizer with first-line fallback"
```

---

### Task 4: channel.ts 接线 — 解析 style、覆盖 replyMode、结束后二次更新

**Files:**
- Modify: `src/bot/channel.ts`（`runAgentBatch` 内 ~L773-851 的 card 分支；import 区）

**接线逻辑：**

1. `runAgentBatch` 的 deps 已有 `mode: ChatMode`，用它解析 style。
2. compact 生效 → 强制 `replyMode = 'card'`（覆盖 `getMessageReplyMode`），因为折叠面板只有交互卡片管线支持。
3. `cardRenderOptions` 带上 `style`。
4. card 分支 producer 里 `await renderDone` 之后：若 compact 且正常 done 且正文 ≥ `SHORT_REPLY_MAX`，调 `summarizeReply`，再 `ctrl.update` 一次带 summary 的最终卡片。fallback 路径（producer 没启动）同理，先算 summary 再一次性 send。

- [ ] **Step 1: 修改 import**

`src/bot/channel.ts` import 区：

- 从 `../config/schema` 的现有 import（含 `getMessageReplyMode` 的那行）追加 `resolveCardStyle`；
- 从 `../card/run-renderer` 的现有 import（含 `renderCard`）追加 `finalReplyText, SHORT_REPLY_MAX`；
- 新增 `import { summarizeReply } from '../agent/summarize';`。

- [ ] **Step 2: 解析 style 并覆盖 replyMode**

把（现 ~L773）：

```ts
  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });
```

替换为：

```ts
  // compact 只能在交互卡片管线上实现（折叠面板），所以 compact 生效时
  // 覆盖 messageReply；streaming 维持用户配置的 messageReply 行为。
  const cardStyle = resolveCardStyle(controls.cfg, mode);
  const replyMode = cardStyle === 'compact' ? 'card' : getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode, cardStyle });
```

- [ ] **Step 3: cardRenderOptions 带上 style**

把（现 ~L782-795）：

```ts
  const cardRenderOptions = callbackAuth
    ? {
        signCallback: (action: string) => ...
      }
    : {};
```

改为（保持 sign 逻辑原样，只加 style 字段）：

```ts
  const cardRenderOptions: RunCardRenderOptions = {
    style: cardStyle,
    ...(callbackAuth
      ? {
          signCallback: (action: string) =>
            callbackAuth.sign({
              runId: execution.runId,
              scope,
              chatId,
              operatorOpenId: firstMsg.senderId,
              action,
              policyFingerprint: flow.policy.policyFingerprint,
              ttlMs: 24 * 60 * 60 * 1000,
            }),
        }
      : {}),
  };
```

`RunCardRenderOptions` 类型从 `../card/run-renderer` import（type-only）。

- [ ] **Step 4: 结束后的总结二次更新**

card 分支 producer（现 ~L829-834）：

```ts
            producer: async (ctrl) => {
              producerStarted = true;
              cardCtrl = ctrl;
              await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
              await renderDone;
            },
```

改为：

```ts
            producer: async (ctrl) => {
              producerStarted = true;
              cardCtrl = ctrl;
              await ctrl.update(renderCard(filterForPrefs(latestState), cardRenderOptions));
              await renderDone;
              // compact：run 结束时卡片已显示「⏳ 正在生成总结…」占位，这里
              // 生成真总结再补一次更新。摘要失败/超时在 summarizeReply 内部
              // 兜底为首句，这里不会 throw。
              const summary = await compactSummaryFor(filterForPrefs(latestState));
              if (summary !== undefined) {
                await ctrl.update(
                  renderCard(filterForPrefs(latestState), { ...cardRenderOptions, summary }),
                );
              }
            },
```

fallback（现 ~L844-850）：

```ts
        fallback: async (state) => {
          await channel.send(
            chatId,
            { card: renderCard(filterForPrefs(state), cardRenderOptions) },
            sendOpts,
          );
        },
```

改为：

```ts
        fallback: async (state) => {
          const filtered = filterForPrefs(state);
          const summary = await compactSummaryFor(filtered);
          const opts2 =
            summary !== undefined ? { ...cardRenderOptions, summary } : cardRenderOptions;
          await channel.send(chatId, { card: renderCard(filtered, opts2) }, sendOpts);
        },
```

并在 `runAgentBatch` 内（card 分支之前、`try {` 之前）定义 helper：

```ts
  // 返回 undefined = 此 run 不需要总结（非 compact / 异常结束 / 短回复）。
  const compactSummaryFor = async (state: RunState): Promise<string | undefined> => {
    if (cardStyle !== 'compact' || state.terminal !== 'done') return undefined;
    const text = finalReplyText(state);
    if (text.length < SHORT_REPLY_MAX) return undefined;
    return summarizeReply(text);
  };
```

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 编译通过，全部测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/bot/channel.ts
git commit -m "feat(bot): wire compact card style — force card pipeline, post-done summary update"
```

---

### Task 5: /config 表单 — cardStyle 选项

**Files:**
- Modify: `src/card/config-card.ts`（`ConfigFormOpts`、`configFormCard`、`configSavedCard`）
- Modify: `src/commands/index.ts`（`showConfigForm` ~L1745、`submitConfig` ~L1790-1872 与 log ~L1910）

- [ ] **Step 1: config-card.ts 加表单项**

`ConfigFormOpts` 加字段（`replyInThreadInGroup` 之后）：

```ts
  cardStyle: CardStyle;
```

import 区：`import type { CardStyle, MessageReplyMode } from '../config/schema';`

`configFormCard` 表单里、`reply_in_thread_in_group` 的 select 之后插入：

```ts
            {
              tag: 'markdown',
              content:
                '\n**卡片呈现风格**\n' +
                '_自动(默认):群聊用「状态栏+一句话结论+折叠详情」的紧凑卡片,私聊保持流式_\n' +
                '_流式:所有聊天实时输出思考/正文/工具过程(原行为)_\n' +
                '_紧凑:所有聊天都用紧凑卡片;运行中只显示状态,结束后展示结论,详情折叠_',
            },
            {
              tag: 'select_static',
              name: 'card_style',
              initial_option: opts.cardStyle,
              options: [
                { text: { tag: 'plain_text', content: '自动(默认)' }, value: 'auto' },
                { text: { tag: 'plain_text', content: '流式' }, value: 'streaming' },
                { text: { tag: 'plain_text', content: '紧凑' }, value: 'compact' },
              ],
            },
```

`configSavedCard` 的群聊设置组里（`群聊话题回复` 行之后）加一行：

```ts
            `**卡片呈现风格**:\`${opts.cardStyle === 'auto' ? '自动' : opts.cardStyle === 'compact' ? '紧凑' : '流式'}\`\n\n` +
```

（注意保持原字符串拼接结构，`群聊话题回复` 行尾原来的 `\n\n` 挪到新行尾。）

- [ ] **Step 2: commands/index.ts 接线**

`showConfigForm`（~L1745 `configFormCard({...})`）加：

```ts
    cardStyle: getCardStylePref(ctx.controls.cfg),
```

`submitConfig` 解析区（`rawReplyInThread` 块之后）加：

```ts
  // Parse card_style. Empty / unexpected keeps current.
  const rawCardStyle = String(fv.card_style ?? '').trim();
  const cardStyle: CardStyle =
    rawCardStyle === 'auto' || rawCardStyle === 'streaming' || rawCardStyle === 'compact'
      ? rawCardStyle
      : getCardStylePref(ctx.controls.cfg);
```

`nextPreferences`（~L1859）加 `cardStyle,`；`log.info('command', 'config-saved', {...})`（~L1910）加 `cardStyle,`。

`submitConfig` 成功后构建 saved card 的地方（L1922 之后，`configSavedCard({...})` 调用处——实现时往下读几行找到它）同样传 `cardStyle`。

import 区从 `../config/schema` 追加 `getCardStylePref` 和 type `CardStyle`。

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS。（config-card 若有快照测试会更新到新表单——检查 diff 只多了 card_style 块。）

- [ ] **Step 4: Commit**

```bash
git add src/card/config-card.ts src/commands/index.ts
git commit -m "feat(config): surface 卡片呈现风格 (cardStyle) in /config card"
```

---

### Task 6: 端到端验证

**Files:** 无新增（验证任务）

- [ ] **Step 1: 全量回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全部 PASS。

- [ ] **Step 2: 真机验证（需要 bot 运行环境）**

按仓库现有启动方式跑 bridge，在一个测试群里：

1. `@bot 随便问一个需要跑几个工具的问题` → 运行中卡片应只有一行状态（工具名实时变化）+ ⏹ 终止按钮，无正文流式；
2. 结束后先见 `⏳ 正在生成总结…`，数秒内变为一句话结论；点开 `📄 查看详情` 能看到完整正文；
3. `@bot 一个一句话就能答的问题` → 回复直接平铺，无折叠无总结；
4. 运行中点 ⏹ 终止 → 卡片显示 `⏹ 已被中断` + 详情（如有正文），无总结；
5. p2p 私聊同样的问题 → 行为与改动前一致（流式）；
6. `/config` 把风格改为 `流式` 再在群里试 → 恢复原流式行为；改回 `自动`。

- [ ] **Step 3: 验证通过后收尾**

若真机验证发现渲染问题（如飞书对面板/元素的实际限制），修复后补跑 Step 1 再提交修复 commit。

---

## Self-Review 记录

- **Spec coverage**：配置三态（Task 1/5）、运行中状态栏（Task 2）、结束后总结+折叠（Task 2/4）、独立 haiku 总结+15s 超时+首句兜底（Task 3）、异常结束不总结（Task 2/4）、短回复直出（Task 2/4）、streaming 不变（Task 2 最后一个测试 + Task 4 覆盖逻辑）、测试要求（各 task）。无缺口。
- **Spec 偏差（已在计划里显式化）**：spec 图里思考/工具面板画在「查看详情」内部；实现为兄弟折叠面板（飞书嵌套 collapsible_panel 支持不可靠）。视觉效果等价：默认都是折叠的。
- **类型一致性**：`CardStyle`/`ResolvedCardStyle`（Task 1）→ `RunCardRenderOptions.style: 'streaming' | 'compact'`（Task 2）→ `resolveCardStyle` 返回值直接可赋值；`finalReplyText`/`SHORT_REPLY_MAX` 的导出与 Task 4 的 import 一致。
