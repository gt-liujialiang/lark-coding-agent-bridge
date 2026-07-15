# 结论聚焦渲染 + 活跃用户台账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给飞书机器人卡片加一个可配置的「结论聚焦」渲染（结论置顶、过程折叠），并本地记录活跃用户台账 + `/stats` 查看命令。

**Architecture:** 结论切分纯在 `run-renderer.ts` 里做（正则找 `## 结论/根因/总结` 标记，切成结论文本 + 过程文本），只在开关开 + run 结束 + 命中标记时生效，否则完全降级到现状。开关是 `AppPreferences.conclusionFocus`，经现有 `/config` 表单读写并传入 `renderCard`。台账是一个用 proper-lockfile 并发安全的 JSON store（`src/observability/active-users.ts`），在 intake 埋点写入、`/stats` 读出汇总卡。

**Tech Stack:** TypeScript (ESM, NodeNext)、vitest、proper-lockfile、飞书 CardKit 2.0。测试用 `pnpm vitest run <path>`。类型检查 `pnpm typecheck`。

---

## 背景速览（实现者必读）

- 卡片渲染入口：`src/card/run-renderer.ts` 的 `renderCard(state, options)`。`state: RunState`（见 `src/card/run-state.ts`）里 `blocks` 是文本/工具块的有序数组，`reasoning` 是思考内容，`terminal` 是终态（`'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout'`）。
- 现有偏好项模式：`src/config/schema.ts` 里 `AppPreferences` 字段 + `getXxx(cfg)` getter（例：`getShowToolCalls`、`getReplyInThreadInGroup`）。
- `/config` 表单：卡在 `src/card/config-card.ts`（`ConfigFormOpts` + `configFormCard` + `configSavedCard`），读写在 `src/commands/index.ts` 的 `handleConfig`（约 L1745）与 `submitConfig`（约 L1790）。
- `renderCard` 的调用与 `cardRenderOptions` 构造在 `src/bot/channel.ts` 约 L782。
- 命令注册在 `src/commands/index.ts` 的 `handlers`（L152）与 `ADMIN_COMMANDS`（L178）；简单回复用 `reply(ctx, markdown)`（L259）；profile 路径用 `commandProfilePaths(ctx)`（L1956，返回 `AppPaths`）。
- intake 埋点位置：`src/bot/channel.ts` 的 `intakeMessage`，access 通过之后（约 L546）。判断发送者人/机用 `senderTypeOf(msg)`（L1209，返回 `'user' | 'bot' | undefined`）。
- 并发安全写文件参考：`src/config/profile-store.ts` 的 `withConfigFileLock`（L102）+ `writeFileAtomic`（`src/platform/atomic-write.ts`）。
- 测试目录：`tests/unit/<domain>/*.test.ts`，import 源码用 `.js` 后缀（NodeNext）。

---

## File Structure

| 文件 | 责任 | 动作 |
| --- | --- | --- |
| `src/config/schema.ts` | 偏好字段 + getter | 加 `conclusionFocus` + `getConclusionFocus` |
| `src/card/run-renderer.ts` | 卡片渲染 | 加结论聚焦切分渲染 + `RunCardRenderOptions.conclusionFocus` |
| `src/bot/channel.ts` | 消息主流程 | 传 `conclusionFocus` 给 renderCard；intake 埋点写台账 |
| `src/card/config-card.ts` | /config 卡片 | 加 toggle + 保存卡展示行 |
| `src/commands/index.ts` | 命令 | /config 读写新字段；新增 `/stats` |
| `src/agent/bridge-system-prompt.ts` | agent 系统提示 | 加结论标记软约定 |
| `src/config/app-paths.ts` | 路径解析 | 加 `activeUsersFile` |
| `src/observability/active-users.ts` | 台账 store | 新建 |
| `tests/unit/config/schema.test.ts` | | 加 `getConclusionFocus` 测试 |
| `tests/unit/card/conclusion-focus.test.ts` | | 新建：切分渲染测试 |
| `tests/unit/config/app-paths.test.ts` | | 加 `activeUsersFile` 断言 |
| `tests/unit/observability/active-users.test.ts` | | 新建：台账 store 测试 |

---

## Task 1: 配置字段 `conclusionFocus` + getter

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/unit/config/schema.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/config/schema.test.ts` 末尾追加（保留文件现有内容，并在顶部 import 里加入 `getConclusionFocus`）：

```ts
import { getConclusionFocus } from '../../../src/config/schema.js';

function cfgWithConclusion(conclusionFocus: boolean | undefined): AppConfig {
  return {
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    preferences: conclusionFocus === undefined ? {} : { conclusionFocus },
  } as AppConfig;
}

describe('getConclusionFocus', () => {
  it('defaults to false when unset', () => {
    expect(getConclusionFocus(cfgWithConclusion(undefined))).toBe(false);
  });

  it('returns true only when explicitly true', () => {
    expect(getConclusionFocus(cfgWithConclusion(true))).toBe(true);
    expect(getConclusionFocus(cfgWithConclusion(false))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/config/schema.test.ts`
Expected: FAIL — `getConclusionFocus is not a function` / import 解析失败。

- [ ] **Step 3: 实现字段与 getter**

在 `src/config/schema.ts` 的 `AppPreferences` 接口里，`showToolCalls` 字段附近加：

```ts
  /**
   * 是否启用「结论聚焦」渲染：把 agent 正文里 `## 结论/根因/总结` 标记之后
   * 的内容醒目置顶，其余过程/证据折叠进面板。默认 false，仅 card 模式生效。
   */
  conclusionFocus?: boolean;
```

在文件里 `getShowToolCalls` 附近加 getter：

```ts
/** Resolve the conclusion-focus preference. Default false — only the
 * explicit `true` opts in, so older configs keep current rendering. */
export function getConclusionFocus(cfg: AppConfig): boolean {
  return cfg.preferences?.conclusionFocus === true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/config/schema.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config/schema.ts tests/unit/config/schema.test.ts
git commit -m "feat(config): add conclusionFocus preference + getConclusionFocus"
```

---

## Task 2: 结论聚焦渲染（run-renderer）

**Files:**
- Modify: `src/card/run-renderer.ts`
- Test: `tests/unit/card/conclusion-focus.test.ts` (create)

- [ ] **Step 1: 写失败测试**

Create `tests/unit/card/conclusion-focus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

// 递归收集所有 markdown content，便于断言。
function markdownContents(card: object): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (rec.tag === 'markdown' && typeof rec.content === 'string') out.push(rec.content);
      Object.values(rec).forEach(walk);
    }
  };
  walk(card);
  return out;
}

function firstTopLevelText(card: object): string {
  const body = (card as { body?: { elements?: Array<Record<string, unknown>> } }).body;
  const first = body?.elements?.[0];
  return first && first.tag === 'markdown' ? String(first.content) : '';
}

const DONE = { type: 'done', terminationReason: 'normal' } as const;

describe('conclusion-focus rendering', () => {
  const investigation = stateFrom([
    { type: 'thinking', delta: '先按班级 ID 查' },
    { type: 'text', delta: '先跑这条 SQL 拿到订单...\n\n关键差异：is_merge_pay=1\n\n' },
    { type: 'text', delta: '## ✅ 结论\n这批订单是微信合单支付，收款走成都星荟。' },
    DONE,
  ]);

  it('splits conclusion to top and folds process when enabled + marker present', () => {
    const card = renderCard(investigation, { conclusionFocus: true });
    // 结论文本置顶（第一个 body 元素）
    expect(firstTopLevelText(card)).toContain('结论');
    expect(firstTopLevelText(card)).toContain('成都星荟');
    // 过程文本收进折叠面板
    const all = JSON.stringify(card);
    expect(all).toContain('排查过程与证据');
    expect(all).toContain('先跑这条 SQL');
  });

  it('falls back to normal rendering when marker absent', () => {
    const noMarker = stateFrom([
      { type: 'text', delta: '直接给你答案：改一行即可。' },
      DONE,
    ]);
    const focused = renderCard(noMarker, { conclusionFocus: true });
    const normal = renderCard(noMarker, {});
    expect(JSON.stringify(focused)).toBe(JSON.stringify(normal));
  });

  it('does not split while running (terminal !== done)', () => {
    const running = stateFrom([
      { type: 'text', delta: '## 结论\n初步结论' },
    ]);
    // running 时不切分：不应出现过程面板标题
    expect(JSON.stringify(renderCard(running, { conclusionFocus: true }))).not.toContain(
      '排查过程与证据',
    );
  });

  it('does nothing when toggle off (identical to default render)', () => {
    const off = renderCard(investigation, { conclusionFocus: false });
    const normal = renderCard(investigation, {});
    expect(JSON.stringify(off)).toBe(JSON.stringify(normal));
  });

  it('uses the last marker when multiple present', () => {
    const multi = stateFrom([
      { type: 'text', delta: '## 结论\n这是中间的假结论小节\n\n## ✅ 结论\n真正的最终结论' },
      DONE,
    ]);
    const card = renderCard(multi, { conclusionFocus: true });
    expect(firstTopLevelText(card)).toContain('真正的最终结论');
    expect(firstTopLevelText(card)).not.toContain('假结论');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/card/conclusion-focus.test.ts`
Expected: FAIL —`renderCard` 尚未支持 `conclusionFocus`，结论不会置顶、无「排查过程与证据」面板。

- [ ] **Step 3: 实现切分渲染**

在 `src/card/run-renderer.ts`：

(a) 顶部常量区（`REASONING_MAX` 附近）加：

```ts
const PROCESS_MAX = 3000;
// 结论标记：行首 1-6 级标题，可带 ✅，标题词为 结论 / 根因 / 总结。
// 全局 flag 供 matchAll 取最后一个匹配。
const CONCLUSION_MARKER = /^#{1,6}\s*(?:✅\s*)?(?:结论|根因|总结)/gm;
```

(b) 扩展选项类型：

```ts
export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  /** 开启后：run 结束且正文命中结论标记时，结论置顶、过程折叠。默认关闭。 */
  conclusionFocus?: boolean;
}
```

(c) 在 `renderCard` 函数体最前面（`const elements: object[] = [];` 之前）加分流：

```ts
  if (options.conclusionFocus && state.terminal === 'done') {
    const split = splitConclusion(state.blocks);
    if (split) return renderConclusionFocusCard(state, split, options);
  }
```

(d) 在文件末尾（`truncate` 附近）加两个函数：

```ts
interface ConclusionSplit {
  conclusion: string;
  process: string;
}

/**
 * 把所有 text block 拼成完整正文，在最后一个结论标记处切开。
 * 无 text / 无标记 → 返回 null（渲染器据此降级）。
 */
function splitConclusion(blocks: Block[]): ConclusionSplit | null {
  const fullText = blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content)
    .join('\n\n')
    .trim();
  if (!fullText) return null;
  const matches = [...fullText.matchAll(CONCLUSION_MARKER)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return null;
  return {
    conclusion: fullText.slice(last.index).trim(),
    process: fullText.slice(0, last.index).trim(),
  };
}

function renderConclusionFocusCard(
  state: RunState,
  split: ConclusionSplit,
  _options: RunCardRenderOptions,
): object {
  const elements: object[] = [];
  // 1. 结论置顶，普通 markdown，不截断。
  elements.push(markdown(split.conclusion));
  // 2. 过程文本折叠面板（可能为空）。
  if (split.process) {
    elements.push(
      collapsiblePanel({
        title: '🔍 **排查过程与证据（点击展开）**',
        expanded: false,
        border: 'blue',
        body: truncate(split.process, PROCESS_MAX),
      }),
    );
  }
  // 3. 思考面板折叠。
  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, false));
  }
  // 4. 工具调用组折叠（finalized）。
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'tools') {
      elements.push(...renderToolGroup(group.tools, true));
    }
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}
```

注意：`CONCLUSION_MARKER` 带 `g` flag，`matchAll` 每次调用会从头扫描；`lastIndex` 不会在多次调用间泄漏，因为用的是 `matchAll`（不改 regex 状态）。不要用同一个 `g` regex 去 `.test()`（那会推进 `lastIndex`）——本任务只用 `matchAll`，安全。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/card/conclusion-focus.test.ts`
Expected: PASS（5 个用例全过）。

- [ ] **Step 5: 跑现有渲染快照确认无回归**

Run: `pnpm vitest run tests/unit/card/run-renderer.snapshot.test.ts`
Expected: PASS（快照不变——现有测试不传 `conclusionFocus`，走原路径）。

- [ ] **Step 6: 提交**

```bash
git add src/card/run-renderer.ts tests/unit/card/conclusion-focus.test.ts
git commit -m "feat(card): conclusion-focus rendering (conclusion on top, process folded)"
```

---

## Task 3: 把 `conclusionFocus` 接进 /config 与渲染调用链

**Files:**
- Modify: `src/card/config-card.ts`
- Modify: `src/commands/index.ts`
- Modify: `src/bot/channel.ts`

本任务是接线，主要靠 `pnpm typecheck` + 手动/集成验证；无独立单测步骤（config-card 无现成单测框架）。

- [ ] **Step 1: config-card 加 toggle + 展示行**

在 `src/card/config-card.ts`：

(a) `ConfigFormOpts` 接口里 `showToolCalls: boolean;` 下方加：

```ts
  conclusionFocus: boolean;
```

(b) 表单元素：在 `show_tool_calls` 的 `select_static` 块之后、`并发上限` markdown 之前，插入：

```ts
            {
              tag: 'markdown',
              content:
                '\n**推理过程折叠 · 结论聚焦**\n' +
                '_开:排查/调查类回答里,结论醒目置顶,过程与证据折叠进面板_\n' +
                '_关(默认):按原样平铺展示全部内容_\n' +
                '_需要 agent 在正文用 `## 结论`/`根因` 标记结论才会生效,否则自动按原样展示_',
            },
            {
              tag: 'select_static',
              name: 'conclusion_focus',
              initial_option: opts.conclusionFocus ? 'on' : 'off',
              options: [
                { text: { tag: 'plain_text', content: '关(默认)' }, value: 'off' },
                { text: { tag: 'plain_text', content: '开' }, value: 'on' },
              ],
            },
```

(c) `configSavedCard` 的展示文案里，`工具调用显示` 那行之后加：

```ts
            `**结论聚焦**:\`${opts.conclusionFocus ? 'on' : 'off'}\`\n` +
```

- [ ] **Step 2: commands/index.ts —— handleConfig 与 submitConfig 接线**

在 `src/commands/index.ts`：

(a) 顶部 schema import 里加入 `getConclusionFocus`（与 `getShowToolCalls` 同一 import 语句）。

(b) `handleConfig` 里构造 `configFormCard({...})` 的对象中，`showToolCalls: getShowToolCalls(ctx.controls.cfg),` 之后加：

```ts
    conclusionFocus: getConclusionFocus(ctx.controls.cfg),
```

(c) `submitConfig` 里，`const showToolCalls = rawTools !== 'hide';` 之后加解析：

```ts
  // Parse conclusion_focus. Empty / unexpected keeps current value.
  const rawConclusion = String(fv.conclusion_focus ?? '').trim();
  let conclusionFocus: boolean;
  if (rawConclusion === 'on') conclusionFocus = true;
  else if (rawConclusion === 'off') conclusionFocus = false;
  else conclusionFocus = getConclusionFocus(ctx.controls.cfg);
```

(d) `nextPreferences: AppPreferences = { ... showToolCalls, ...}` 对象里加 `conclusionFocus,`。

(e) `log.info('command', 'config-saved', {...})` 里加 `conclusionFocus,`。

(f) `configSavedCard({...})` 调用对象里 `showToolCalls,` 之后加 `conclusionFocus,`。

- [ ] **Step 3: channel.ts —— 把 flag 传给 renderCard**

在 `src/bot/channel.ts`：

(a) schema import（约 L36-38，含 `getShowToolCalls`）里加入 `getConclusionFocus`。

(b) 把 `cardRenderOptions`（约 L782）改成始终带 `conclusionFocus`：

```ts
  const cardRenderOptions: import('../card/run-renderer').RunCardRenderOptions = {
    conclusionFocus: getConclusionFocus(controls.cfg),
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

（`conclusionFocus` 在 run 开始时读一次即可——它只在终态 `done` 时影响渲染，mid-run 切 /config 的极端情况不处理，符合 YAGNI。）

- [ ] **Step 4: 类型检查 + 全量单测**

Run: `pnpm typecheck && pnpm vitest run tests/unit`
Expected: PASS，无类型错误。

- [ ] **Step 5: 提交**

```bash
git add src/card/config-card.ts src/commands/index.ts src/bot/channel.ts
git commit -m "feat(config): wire conclusionFocus through /config form and card render"
```

---

## Task 4: agent 结论标记软约定

**Files:**
- Modify: `src/agent/bridge-system-prompt.ts`

- [ ] **Step 1: 在系统提示末尾加约定小节**

在 `src/agent/bridge-system-prompt.ts` 的 `BRIDGE_SYSTEM_PROMPT` 模板字符串末尾（最后一段 `7. 如果用户中途想取消...` 之后、闭合反引号之前）加：

```
## 输出结构建议（结论聚焦）

当你的回答是排查 / 调查 / 定位问题类,或有一个明确的结论时:

- 把关键结论放在一个 \`## ✅ 结论\` 标题下(需要时可写成「结论 / 根因」),用 \`结论\` / \`根因\` / \`总结\` 作标题词。
- 过程、证据、中间数据(SQL、查询结果、表格、日志、路由记录等)放在这个标题**之前**。
- 结论要能独立读懂:直接给判断和依据,不要只写「见上」。

日常简单回答(改一行、闲聊、单句答复)**不需要**这个结构,正常回答即可。这只是展示层面的建议——飞书端可能据此把过程折叠、结论置顶;你判断不适用时忽略即可,不影响正确性。
```

（注意:小节内的行内代码用了 `\`` 转义,因为整体在反引号模板串里。）

- [ ] **Step 2: 类型检查确认字符串合法**

Run: `pnpm typecheck`
Expected: PASS（无未闭合模板串 / 转义错误）。

- [ ] **Step 3: 快速验证提示文本包含约定**

Run: `pnpm vitest run tests/unit/agent --passWithNoTests`
Expected: PASS（如无 agent 相关提示测试则空跑通过）。可选：手动 `grep "结论聚焦" src/agent/bridge-system-prompt.ts` 确认已写入。

- [ ] **Step 4: 提交**

```bash
git add src/agent/bridge-system-prompt.ts
git commit -m "feat(agent): add conclusion-marker output convention to bridge system prompt"
```

---

## Task 5: 台账 store `active-users.ts`

**Files:**
- Create: `src/observability/active-users.ts`
- Test: `tests/unit/observability/active-users.test.ts` (create)

- [ ] **Step 1: 写失败测试**

Create `tests/unit/observability/active-users.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readActiveUsers,
  recordActiveUser,
} from '../../../src/observability/active-users.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'active-users-'));
  file = join(dir, 'active-users.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('active-users store', () => {
  it('returns empty array when file missing', async () => {
    expect(await readActiveUsers(file)).toEqual([]);
  });

  it('creates a record on first sight', async () => {
    await recordActiveUser(file, {
      openId: 'ou_1',
      name: '张三',
      chatId: 'oc_1',
      chatType: 'p2p',
      at: '2026-07-15T10:00:00.000Z',
    });
    const users = await readActiveUsers(file);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      openId: 'ou_1',
      name: '张三',
      chatId: 'oc_1',
      chatType: 'p2p',
      firstSeenAt: '2026-07-15T10:00:00.000Z',
      lastSeenAt: '2026-07-15T10:00:00.000Z',
      messageCount: 1,
    });
  });

  it('increments count and updates lastSeen/name/chat on repeat', async () => {
    await recordActiveUser(file, {
      openId: 'ou_1', name: '张三', chatId: 'oc_1', chatType: 'p2p',
      at: '2026-07-15T10:00:00.000Z',
    });
    await recordActiveUser(file, {
      openId: 'ou_1', name: '张三丰', chatId: 'oc_2', chatType: 'group',
      at: '2026-07-15T11:00:00.000Z',
    });
    const users = await readActiveUsers(file);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      messageCount: 2,
      name: '张三丰',
      chatId: 'oc_2',
      chatType: 'group',
      firstSeenAt: '2026-07-15T10:00:00.000Z',
      lastSeenAt: '2026-07-15T11:00:00.000Z',
    });
  });

  it('tracks multiple distinct users', async () => {
    await recordActiveUser(file, { openId: 'ou_1', chatId: 'oc_1', chatType: 'p2p', at: '2026-07-15T10:00:00.000Z' });
    await recordActiveUser(file, { openId: 'ou_2', chatId: 'oc_1', chatType: 'p2p', at: '2026-07-15T10:01:00.000Z' });
    expect(await readActiveUsers(file)).toHaveLength(2);
  });

  it('does not lose updates under sequential concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordActiveUser(file, {
          openId: 'ou_1', chatId: 'oc_1', chatType: 'p2p',
          at: `2026-07-15T10:0${i}:00.000Z`,
        }),
      ),
    );
    const users = await readActiveUsers(file);
    expect(users).toHaveLength(1);
    expect(users[0].messageCount).toBe(5);
  });

  it('returns empty array on corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json{{{');
    expect(await readActiveUsers(file)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/observability/active-users.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现 store**

Create `src/observability/active-users.ts`:

```ts
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ActiveUserRecord {
  openId: string;
  name?: string;
  /** 最近一次提问所在 chat。 */
  chatId: string;
  /** p2p | group | ... */
  chatType: string;
  /** ISO 时间戳。 */
  firstSeenAt: string;
  lastSeenAt: string;
  messageCount: number;
}

export interface RecordActiveUserInput {
  openId: string;
  name?: string;
  chatId: string;
  chatType: string;
  /** ISO 时间戳;缺省取当前时间(注入便于测试)。 */
  at?: string;
}

/** 只读加载台账;文件缺失 / 损坏 / 非数组 → 返回空数组。 */
export async function readActiveUsers(filePath: string): Promise<ActiveUserRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isActiveUserRecord) : [];
  } catch {
    return [];
  }
}

/** upsert 一条活跃用户记录(按 openId)。并发安全(proper-lockfile)。 */
export async function recordActiveUser(
  filePath: string,
  input: RecordActiveUserInput,
): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await withLedgerLock(filePath, async () => {
    const records = await readActiveUsers(filePath);
    const existing = records.find((r) => r.openId === input.openId);
    if (existing) {
      existing.messageCount += 1;
      existing.lastSeenAt = at;
      existing.chatId = input.chatId;
      existing.chatType = input.chatType;
      if (input.name) existing.name = input.name;
    } else {
      records.push({
        openId: input.openId,
        ...(input.name ? { name: input.name } : {}),
        chatId: input.chatId,
        chatType: input.chatType,
        firstSeenAt: at,
        lastSeenAt: at,
        messageCount: 1,
      });
    }
    await writeFileAtomic(filePath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  });
}

async function withLedgerLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockTarget = `${filePath}.lock`;
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, '', { flag: 'a', mode: 0o600 });
  await chmod(lockTarget, 0o600).catch(() => {});
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function isActiveUserRecord(v: unknown): v is ActiveUserRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.openId === 'string' &&
    typeof r.chatId === 'string' &&
    typeof r.chatType === 'string' &&
    typeof r.firstSeenAt === 'string' &&
    typeof r.lastSeenAt === 'string' &&
    typeof r.messageCount === 'number'
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/observability/active-users.test.ts`
Expected: PASS（6 个用例全过）。

- [ ] **Step 5: 提交**

```bash
git add src/observability/active-users.ts tests/unit/observability/active-users.test.ts
git commit -m "feat(observability): add active-users ledger store"
```

---

## Task 6: `activeUsersFile` 路径

**Files:**
- Modify: `src/config/app-paths.ts`
- Test: `tests/unit/config/app-paths.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/config/app-paths.test.ts` 里已有的 `resolveAppPaths` 测试块中，追加一条断言（若文件已有类似「computes profile paths」的用例，加进去；否则新增）：

```ts
  it('places active-users ledger under the profile dir', () => {
    const paths = resolveAppPaths({ rootDir: '/root', profile: 'claude' });
    expect(paths.activeUsersFile).toBe('/root/profiles/claude/active-users.json');
  });
```

（若测试文件顶部还没 import `resolveAppPaths`，按现有风格补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/config/app-paths.test.ts`
Expected: FAIL — `activeUsersFile` 属性不存在 / undefined。

- [ ] **Step 3: 实现**

在 `src/config/app-paths.ts`：

(a) `AppPaths` 接口里 `logsDir: string;` 附近加：

```ts
  activeUsersFile: string;
```

(b) `resolveAppPaths` 的返回对象里 `logsDir: join(profileDir, 'logs'),` 附近加：

```ts
    activeUsersFile: join(profileDir, 'active-users.json'),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/config/app-paths.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/config/app-paths.ts tests/unit/config/app-paths.test.ts
git commit -m "feat(config): add activeUsersFile path under profile dir"
```

---

## Task 7: intake 埋点写台账

**Files:**
- Modify: `src/bot/channel.ts`

接线任务，靠 `pnpm typecheck` + 集成验证。

- [ ] **Step 1: 加 import**

在 `src/bot/channel.ts` 顶部：
- 值 import：`import { resolveAppPaths } from '../config/app-paths';`（当前只 import 了类型 `AppPaths`，改成同时 import 值与类型，或新增一行值 import）。
- `import { recordActiveUser } from '../observability/active-users';`
- 确认 `dirname` 已从 `node:path` 引入（L7 已有 `import { dirname, join } from 'node:path';`）。

- [ ] **Step 2: 在 intake access 通过后埋点**

在 `intakeMessage` 里、access 检查通过之后（约 L546，`accessDecision.ok` 为真、`return` 之外的正常路径上，`tryHandleCommand` 之前）加：

```ts
  // 记录活跃用户台账(仅真人;失败不阻塞主流程)。
  if (senderTypeOf(msg) === 'user') {
    const activeUsersFile = resolveAppPaths({
      rootDir: dirname(controls.configPath),
      profile: controls.profile,
    }).activeUsersFile;
    void recordActiveUser(activeUsersFile, {
      openId: msg.senderId,
      name: msg.senderName,
      chatId: msg.chatId,
      chatType: msg.chatType,
    }).catch((err) =>
      log.warn('intake', 'active-user-record-failed', { err: String(err) }),
    );
  }
```

（`senderTypeOf` 在同文件 L1209 定义，模块内函数提升，可直接调用。仅记 `'user'`，跳过 bot 与未知类型——与设计一致。）

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/bot/channel.ts
git commit -m "feat(bot): record active users into ledger at intake"
```

---

## Task 8: `/stats` 命令

**Files:**
- Modify: `src/commands/index.ts`

- [ ] **Step 1: 加 import 与 handler**

在 `src/commands/index.ts`：

(a) 顶部加：`import { readActiveUsers, type ActiveUserRecord } from '../observability/active-users';`

(b) 在其他 handler 附近（如 `handleStatus` 之后）加：

```ts
async function handleStats(_args: string, ctx: CommandContext): Promise<void> {
  const file = commandProfilePaths(ctx).activeUsersFile;
  const users = await readActiveUsers(file);
  if (users.length === 0) {
    await reply(ctx, '📊 暂无活跃用户记录。');
    return;
  }
  const total = users.length;
  const totalMessages = users.reduce((s, u) => s + u.messageCount, 0);
  const label = (u: ActiveUserRecord): string => u.name ?? u.openId.slice(-6);
  const fmtTime = (iso: string): string => iso.slice(0, 16).replace('T', ' ');
  const topAskers = [...users]
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, 10);
  const recent = [...users]
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, 5);
  const lines = [
    '📊 **活跃用户台账**',
    '',
    `**总活跃用户**:${total}　**累计提问**:${totalMessages}`,
    '',
    `**提问最多 Top ${topAskers.length}**`,
    ...topAskers.map((u, i) => `${i + 1}. ${label(u)} — ${u.messageCount} 次`),
    '',
    '**最近活跃**',
    ...recent.map((u) => `- ${label(u)} · ${fmtTime(u.lastSeenAt)}`),
  ];
  await reply(ctx, lines.join('\n'));
}
```

(c) 在 `handlers` 对象里加：`'/stats': handleStats,`

(d) 在 `ADMIN_COMMANDS` 集合里加：`'/stats',`

(e)（可选）在 `handleHelp` 的命令清单里补一行 `/stats` 的说明（若 help 卡是逐条列命令的话），描述:「/stats — 查看活跃用户台账（管理员）」。若 help 结构复杂，此步可跳过并在提交信息里注明。

- [ ] **Step 2: 类型检查 + 全量单测**

Run: `pnpm typecheck && pnpm vitest run tests/unit`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/commands/index.ts
git commit -m "feat(commands): add /stats to view active-user ledger (admin)"
```

---

## Task 9: 全量验证与文档

**Files:**
- Modify: `README.md` / `README.zh.md`（可选，补 `/stats` 与结论聚焦开关说明）

- [ ] **Step 1: 本地 CI**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全部 PASS，构建成功。

- [ ] **Step 2: 端到端手动验证（使用 verify skill 或手动）**

用 `/run` 或本地起 bridge，走一遍：
1. `/config` 打开「结论聚焦」→ 保存卡显示 `结论聚焦:on`。
2. 让 agent 产出一段带 `## ✅ 结论` 的排查类回答 → 卡片结论置顶、过程折叠。
3. 让 agent 产出一段无结论标记的普通回答 → 卡片按原样展示（无过程面板）。
4. 在私聊发一条消息 → `~/.lark-channel/profiles/<profile>/active-users.json` 出现记录、`messageCount` 累加。
5. `/stats` → 回汇总卡。

- [ ] **Step 3:（可选）更新 README**

在 `README.zh.md` / `README.md` 的偏好 / 命令小节补：结论聚焦开关、`/stats` 命令。

- [ ] **Step 4: 提交**

```bash
git add README.md README.zh.md
git commit -m "docs: document conclusion-focus toggle and /stats command"
```

---

## Self-Review 记录

- **Spec 覆盖**：组件1→Task4；组件2→Task2；组件3→Task1+Task3；组件4→Task5/6/7/8。测试要求（renderer 切分/降级/多标记/运行中/开关关、getConclusionFocus、active-users store）→ Task2 + Task1 + Task5 均已含具体测试代码。
- **占位符**：无 TBD / “类似上文” / 空泛「加错误处理」——错误处理均有具体降级路径（readActiveUsers catch→[]、intake fire-and-forget catch→warn、renderer 无标记→降级）。
- **类型一致**：`RunCardRenderOptions.conclusionFocus`、`getConclusionFocus`、`ActiveUserRecord`/`RecordActiveUserInput`、`readActiveUsers`/`recordActiveUser`、`AppPaths.activeUsersFile`、config 字段 `conclusion_focus`（表单 name）↔ `conclusionFocus`（TS 字段）在各任务间保持一致。
