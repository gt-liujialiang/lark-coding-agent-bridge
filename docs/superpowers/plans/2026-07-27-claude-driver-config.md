# Claude Driver: headless / PTY 双驱动 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `ClaudeAdapter` 内提供 headless / PTY 两种 claude 驱动，用 `config.json` 的 `claudeDriver` 字段切换，默认 `'pty'`。

**Architecture:** 两个独立的 `AgentAdapter` 实现类（`ClaudeHeadlessAdapter` / `ClaudePtyAdapter`）共享 `AgentRun`/`AgentEvent` 接口，`start.ts` 工厂按 `getClaudeDriver(cfg)` 二选一。`/config` 卡片加驱动选项。

**Tech Stack:** TypeScript, vitest, node-pty (PTY 路径), spawnProcess + stream-json (headless 路径)

**Spec:** `docs/superpowers/specs/2026-07-27-claude-driver-config-design.md`

---

### Task 1: Config schema — ClaudeDriver 类型 + getClaudeDriver 访问器

**Files:**
- Modify: `src/config/schema.ts`

- [ ] **Step 1: 添加 ClaudeDriver 类型和 getClaudeDriver 访问器**

在 `getToolCallDisplay` 函数上方添加类型常量和类型导出，在 `getShowToolCalls` 之后添加 `getClaudeDriver` 访问器。

```ts
// 在 `export type ToolCallDisplay = 'full' | 'compact' | 'hide';` 之后添加：

const CLAUDE_DRIVER_OPTIONS = ['pty', 'headless'] as const;
export type ClaudeDriver = (typeof CLAUDE_DRIVER_OPTIONS)[number];

// 在 `getShowToolCalls` 函数之后添加：

/**
 * Resolve the claude driver mode. Default `'pty'` — the `!== 'headless'`
 * check makes older configs without the field inherit the default.
 *
 * - `pty`: long-lived PTY + JSONL tailing (supports AskUserQuestion,
 *   idle checkout, …)
 * - `headless`: `claude -p --output-format stream-json` (stateless,
 *   one process per turn, clean tool rendering)
 */
export function getClaudeDriver(cfg: AppConfig): ClaudeDriver {
  const v = cfg.preferences?.claudeDriver;
  if (v === 'headless') return 'headless';
  return 'pty';
}
```

- [ ] **Step 2: 在 AppPreferences 接口中添加 claudeDriver 字段**

在 `AppPreferences` 接口中的 `claudeP2pAutoApprove` 字段后面添加：

```ts
  /**
   * How claude is driven. `pty` (default) uses a long-lived pseudo-terminal
   * with JSONL log tailing; `headless` uses `claude -p --output-format
   * stream-json` (one process per turn, no TUI interactions).
   */
  claudeDriver?: ClaudeDriver;
```

- [ ] **Step 3: 验证类型检查**

```bash
pnpm typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/config/schema.ts
git commit -m "feat(config): add ClaudeDriver type and getClaudeDriver accessor"
```

---

### Task 2: Config card — 表单加 driver 选项

**Files:**
- Modify: `src/card/config-card.ts`

- [ ] **Step 1: ConfigFormOpts 加 claudeDriver 字段**

在 `ConfigFormOpts` 接口末尾（`replyInThreadInGroup` 之后）添加：

```ts
  /** claude 驱动方式。默认 'pty'。 */
  claudeDriver: 'pty' | 'headless';
```

- [ ] **Step 2: configFormCard 表单加 driver 选择器**

在 `reply_in_thread_in_group` 的 select_static 块之后、lark-cli 身份策略之前，插入 driver 选项（位置：约 line 232，`lark_cli_identity` 的 markdown label 上方）：

```ts
            {
              tag: 'markdown',
              content:
                '\n**Claude 驱动方式**\n' +
                '_PTY(默认):伪终端常驻,支持交互式问答和长任务探活;需 node-pty_\n' +
                '_Headless:claude -p 无头模式,工具渲染更干净,一轮一进程_',
            },
            {
              tag: 'select_static',
              name: 'claude_driver',
              initial_option: opts.claudeDriver,
              options: [
                { text: { tag: 'plain_text', content: 'PTY(默认)' }, value: 'pty' },
                { text: { tag: 'plain_text', content: 'Headless' }, value: 'headless' },
              ],
            },
```

- [ ] **Step 3: configSavedCard 确认卡片加 driver 行**

在 `configSavedCard` 函数中，`群聊话题回复` 行之后和 `lark-cli 身份策略` 行之前，追加 driver 显示：

```ts
            `**群聊话题回复**:\`${opts.replyInThreadInGroup ? '是' : '否'}\`\n` +
            `**Claude 驱动**:\`${opts.claudeDriver === 'headless' ? 'Headless' : 'PTY'}\`\n\n` +
```

- [ ] **Step 4: 提交**

```bash
git add src/card/config-card.ts
git commit -m "feat(config-card): add claude driver option to config form"
```

---

### Task 3: Config submit — handleConfig 处理 claude_driver 字段

**Files:**
- Modify: `src/commands/index.ts`

- [ ] **Step 1: 在 showConfigForm 中传入 claudeDriver**

在 `showConfigForm` 函数 (line ~1935) 的 `configFormCard({...})` 中添加：

```ts
    claudeDriver: getClaudeDriver(ctx.controls.cfg),
```
插入在 `replyInThreadInGroup: ...` 和 `larkCliIdentity: ...` 之间。

- [ ] **Step 2: 在 submitConfig 中解析 claude_driver 表单值**

在 `submitConfig` 函数中，`rawReplyInThread` 解析之后（line ~2039, `replyInThreadInGroup = ...` 之后）添加 driver 解析：

```ts
  const rawDriver = String(fv.claude_driver ?? '').trim();
  const claudeDriver: 'pty' | 'headless' =
    rawDriver === 'headless' ? 'headless' : 'pty';
```

在 `nextPreferences` 对象（line ~2063）中添加：

```ts
      claudeDriver,
```
插入在 `replyInThreadInGroup` 之后。

- [ ] **Step 3: 提交**

```bash
git add src/commands/index.ts
git commit -m "feat(config): wire claudeDriver into showConfigForm and submitConfig"
```

---

### Task 4: stream-json.ts — 从 main 恢复

**Files:**
- Create: `src/agent/claude/stream-json.ts`

- [ ] **Step 1: 从 main 恢复 stream-json.ts 全文**

```bash
git show main:src/agent/claude/stream-json.ts > src/agent/claude/stream-json.ts
git add src/agent/claude/stream-json.ts
```

- [ ] **Step 2: 提交**

```bash
git commit -m "feat(agent): restore stream-json.ts from main for headless driver"
```

---

### Task 5: pty-adapter.ts — 移动当前 PTY adapter

**Files:**
- Create: `src/agent/claude/pty-adapter.ts`
- Modify: `src/agent/claude/adapter.ts`（下一步重写）

- [ ] **Step 1: 复制当前 adapter.ts 到 pty-adapter.ts 并改类名**

```bash
cp src/agent/claude/adapter.ts src/agent/claude/pty-adapter.ts
```

然后编辑 `pty-adapter.ts`：
- 类名 `ClaudeAdapter` → `ClaudePtyAdapter`
- 接口名 `ClaudeAdapterOptions` → `ClaudePtyAdapterOptions`
- 所有自身引用（如 `adapter: ClaudeAdapter` → `adapter: ClaudePtyAdapter`）
- 注释中 `ClaudeAdapter` → `ClaudePtyAdapter`（类注释 + JSDoc 引用）

具体替换：

```ts
// Line ~21: 接口名
export interface ClaudePtyAdapterOptions {

// Line ~32: 类名
export class ClaudePtyAdapter implements AgentAdapter {

// Line ~44: constructor 参数类型
  constructor(opts: ClaudePtyAdapterOptions = {}) {

// Line ~77: error message
    if (!opts.cwd) throw new Error('cwd is required for ClaudePtyAdapter.run');

// Line ~98: 类型注解
      adapter: ClaudePtyAdapter,
```

- [ ] **Step 2: 提交**

```bash
git add src/agent/claude/pty-adapter.ts
git commit -m "feat(agent): extract ClaudePtyAdapter into pty-adapter.ts"
```

---

### Task 6: adapter.ts — 重写为 ClaudeHeadlessAdapter

**Files:**
- Modify: `src/agent/claude/adapter.ts`

- [ ] **Step 1: 从 main 恢复 headless adapter 全文 + 加 no-op stubs**

```bash
git show main:src/agent/claude/adapter.ts > src/agent/claude/adapter.ts
```

然后编辑 `adapter.ts`：

类名改为 `ClaudeHeadlessAdapter`，接口名改为 `ClaudeHeadlessAdapterOptions`：

```ts
export interface ClaudeHeadlessAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
}

export class ClaudeHeadlessAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code (headless)';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeHeadlessAdapterOptions = {}) {
```

文件底部导入 `ClaudeAdapter` 的残留引用替换为 `ClaudeHeadlessAdapter`。无需额外改 `AgentRun`——`answerQuestion` 和 `resetIdleCheckpoint` 在 types.ts 中已经是 `?` 可选，不加 stub。

- [ ] **Step 2: 提交**

```bash
git add src/agent/claude/adapter.ts
git commit -m "feat(agent): ClaudeHeadlessAdapter — restored main's claude -p + stream-json driver"
```

---

### Task 7: agent/index.ts — 更新导出

**Files:**
- Modify: `src/agent/index.ts`

- [ ] **Step 1: 替换导出**

将当前内容：

```ts
export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { ClaudeAdapter } from './claude/adapter';
export { CodexAdapter } from './codex/adapter';
```

改为：

```ts
export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { ClaudeHeadlessAdapter } from './claude/adapter';
export { ClaudePtyAdapter } from './claude/pty-adapter';
export { CodexAdapter } from './codex/adapter';
```

- [ ] **Step 2: 提交**

```bash
git add src/agent/index.ts
git commit -m "feat(agent): export ClaudeHeadlessAdapter + ClaudePtyAdapter"
```

---

### Task 8: start.ts — 工厂按 claudeDriver 二选一

**Files:**
- Modify: `src/cli/commands/start.ts`

- [ ] **Step 1: 更新 import**

将：

```ts
import { ClaudeAdapter } from '../../agent/claude/adapter';
```

改为：

```ts
import { ClaudeHeadlessAdapter, ClaudePtyAdapter } from '../../agent';
```

- [ ] **Step 2: 在工厂中添加 driver 分支**

将 line ~442 的：

```ts
  return new ClaudeAdapter({ larkChannel });
```

改为：

```ts
  const claudeDriver = getClaudeDriver(rootConfig);
  if (claudeDriver === 'headless') {
    return new ClaudeHeadlessAdapter({ larkChannel });
  }
  return new ClaudePtyAdapter({ larkChannel });
```

需确保文件顶部已 import `getClaudeDriver`：

```ts
import { ..., getClaudeDriver } from '../../config/schema';
```

- [ ] **Step 3: 提交**

```bash
git add src/cli/commands/start.ts
git commit -m "feat(start): switch adapter on claudeDriver config — headless vs PTY"
```

---

### Task 9: 测试 — 更新 PTY 测试 import

**Files:**
- Modify: `tests/integration/claude/pty-adapter.test.ts`
- Modify: `tests/unit/agent/adapter-system-prompt-wiring.test.ts`

- [ ] **Step 1: pty-adapter.test.ts — 改 import**

```ts
// 将：
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
// 改为：
import { ClaudePtyAdapter } from '../../../src/agent/claude/pty-adapter.js';
```

测试内部的 `new ClaudeAdapter({...})` 改为 `new ClaudePtyAdapter({...})`。

- [ ] **Step 2: adapter-system-prompt-wiring.test.ts — 改 import + 类名**

```ts
// 将：
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
// 改为：
import { ClaudePtyAdapter } from '../../../src/agent/claude/pty-adapter';
```

测试内部的：
- `new ClaudeAdapter({ readinessQuietMs: 0 })` → `new ClaudePtyAdapter({ readinessQuietMs: 0 })`
- `new ClaudeAdapter()` → `new ClaudePtyAdapter()`

- [ ] **Step 3: 提交**

```bash
git add tests/integration/claude/pty-adapter.test.ts tests/unit/agent/adapter-system-prompt-wiring.test.ts
git commit -m "test: update PTY test imports — ClaudeAdapter → ClaudePtyAdapter"
```

---

### Task 10: 测试 — 恢复 headless 测试

**Files:**
- Create: `tests/unit/agent/claude-stream-json.test.ts`
- Create: `tests/process/claude-headless-adapter.test.ts`

- [ ] **Step 1: 恢复 stream-json 单元测试**

```bash
git show main:tests/unit/agent/claude-stream-json.test.ts > tests/unit/agent/claude-stream-json.test.ts
```

编辑文件，更新 import：
```ts
// 将：
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
// 改为（这个测试用 Adapter 做集成冒烟，需要导入 ClaudeHeadlessAdapter）：
import { ClaudeHeadlessAdapter } from '../../../src/agent/claude/adapter.js';
```

所有 `new ClaudeAdapter(...)` → `new ClaudeHeadlessAdapter(...)`。

- [ ] **Step 2: 恢复 claude-adapter process 测试**

```bash
git show main:tests/process/claude-adapter.test.ts > tests/process/claude-headless-adapter.test.ts
```

编辑文件，更新 import：
```ts
import { ClaudeHeadlessAdapter } from '../../src/agent/claude/adapter.js';
```
所有 `new ClaudeAdapter(...)` → `new ClaudeHeadlessAdapter(...)`。

- [ ] **Step 3: 提交**

```bash
git add tests/unit/agent/claude-stream-json.test.ts tests/process/claude-headless-adapter.test.ts
git commit -m "test: restore headless driver tests — stream-json + adapter process contract"
```

---

### Task 11: 测试 — adapter-system-prompt-wiring 加 headless 用例

**Files:**
- Modify: `tests/unit/agent/adapter-system-prompt-wiring.test.ts`

- [ ] **Step 1: 添加 ClaudeHeadlessAdapter 的 system prompt wiring 测试**

在现有 `ClaudePtyAdapter system prompt wiring` describe 块之后、`CodexAdapter` 块之前添加：

```ts
describe('ClaudeHeadlessAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt after setBotIdentity', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);

    const adapter = new ClaudeHeadlessAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);

    const adapter = new ClaudeHeadlessAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt');
    expect(args[flagIndex + 1]).toBe(buildBridgeSystemPrompt(undefined));
  });

  it('requests token-level partial messages so replies stream incrementally', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());

    new ClaudeHeadlessAdapter().run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--include-partial-messages');
  });
});
```

在文件顶部 import 中添加：

```ts
import { ClaudeHeadlessAdapter } from '../../../src/agent/claude/adapter';
```

- [ ] **Step 2: 运行测试验证**

```bash
pnpm vitest run tests/unit/agent/adapter-system-prompt-wiring.test.ts
```

- [ ] **Step 3: 提交**

```bash
git add tests/unit/agent/adapter-system-prompt-wiring.test.ts
git commit -m "test: add ClaudeHeadlessAdapter system prompt + streaming flag tests"
```

---

### Task 12: 测试 — driver config 单元测试

**Files:**
- Create: `tests/unit/config/claude-driver.test.ts`

- [ ] **Step 1: 编写 getClaudeDriver 测试**

```ts
import { describe, expect, it } from 'vitest';
import { getClaudeDriver, type AppConfig } from '../../../src/config/schema.js';

function cfg(driver?: string): AppConfig {
  return {
    preferences: driver !== undefined ? { claudeDriver: driver as 'pty' | 'headless' } : {},
  };
}

describe('getClaudeDriver', () => {
  it('defaults to pty when no preference is set', () => {
    expect(getClaudeDriver(cfg(undefined))).toBe('pty');
    expect(getClaudeDriver({ preferences: {} })).toBe('pty');
  });

  it('returns headless when explicitly set', () => {
    expect(getClaudeDriver(cfg('headless'))).toBe('headless');
  });

  it('returns pty when explicitly set', () => {
    expect(getClaudeDriver(cfg('pty'))).toBe('pty');
  });

  it('returns pty for unknown values (forward compatible)', () => {
    expect(getClaudeDriver(cfg('unknown'))).toBe('pty');
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
pnpm vitest run tests/unit/config/claude-driver.test.ts
```

- [ ] **Step 3: 提交**

```bash
git add tests/unit/config/claude-driver.test.ts
git commit -m "test: add getClaudeDriver unit tests"
```

---

### Task 13: 全量 typecheck + test + build

**Files:** (无 — 验证步骤)

- [ ] **Step 1: Typecheck**

```bash
pnpm typecheck
```
预期：无错误。

- [ ] **Step 2: 全量测试**

```bash
pnpm test
```
预期：所有测试通过，包括新恢复的 headless 测试、PTY 端到端测试、config 测试。

- [ ] **Step 3: Build**

```bash
pnpm build
```
预期：成功，dist/ 产物大小合理。

- [ ] **Step 4: 提交**（如有修改后的文件需要 amend）

```bash
git status
# 如果干净 → 跳过
# 如果有 lint/type 修复 → git add -A && git commit -m "chore: fix typecheck/test issues after driver merge"
```

---

### Task 14: 最终提交整合

- [ ] **Step 1: 查看整体 diff 摘要**

```bash
git log --oneline feat/claude-pty-integrated~1..feat/claude-pty-integrated
```
确认提交列表覆盖所有变更。

- [ ] **Step 2: 验证无合并残留**

```bash
grep -rn '<<<<<<<\|>>>>>>>\|^=======$' src/ tests/ 2>/dev/null | grep -v '.snap'
```
预期：无输出。
