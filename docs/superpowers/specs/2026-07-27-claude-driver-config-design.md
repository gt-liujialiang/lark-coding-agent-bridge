# Claude Driver: headless / PTY 双驱动

**Date:** 2026-07-27
**Branch:** `feat/claude-pty-integrated`
**Status:** Approved design — ready for implementation plan

## Goal

`ClaudeAdapter` 提供两种 claude 驱动方式，用 config 切换：
- **headless**（`claude -p` + stream-json）：main 原有方式，工具渲染干净，无交互。
- **pty**（node-pty + jsonl）：当前分支方式，支持 AskUserQuestion 等 TUI 交互。

## Motivation

`claude -p` 并未被废弃（最初对 PTY 分支的假设排除了它）。实际上二者各有优势：

| 维度 | headless | pty |
|---|---|---|
| 工具渲染 | 干净，compact 模式下一行表头 | 完整，含 Command / Output 展开 |
| 交互能力 | 无（`ask_user_question` 事件不触发） | 有（AskUserQuestion 卡片、idle checkpoint） |
| 会话持久 | 每次新进程 | 一个 PTY 跨 turn 复用 |
| /new /resume 感知 | 无持久态 | 需显式 closeSession 释放 PTY |

将 headless 恢复并与 pty 并存，用户按场景选择。

## Design

### 1. Config

`config/schema.ts` 新增字段、类型、访问器：

```ts
const CLAUDE_DRIVER_OPTIONS = ['pty', 'headless'] as const;
export type ClaudeDriver = (typeof CLAUDE_DRIVER_OPTIONS)[number];

export function getClaudeDriver(cfg: AppConfig): ClaudeDriver {
  const v = cfg.preferences?.claudeDriver;
  if (v === 'headless') return 'headless';
  return 'pty'; // 默认
}
```

`AppPreferences` 加：

```ts
claudeDriver?: ClaudeDriver;
```

**`/config` 卡片** (`config-card.ts`)：加 driver 单选（pty / headless），对齐 `messageReply` / `toolCallDisplay` 的选项渲染。

**生效时机**：和下一条用户消息一起（/config 偏好都是下一次 flush 生效；driver 选择在 `start.ts` 初始化 adapter 时，重启 bot 后或下一次 `/cd`/`/reset` 触发的 adapter 重建后生效）。

### 2. Architecture

```
src/agent/claude/
├── adapter.ts           ← ClaudeHeadlessAdapter（从 main 恢复：
│                           spawnProcess + stream-json + --include-partial-messages）
├── stream-json.ts       ← 从 main 恢复（createStreamJsonTranslator 等，同原来的内容）
├── pty-adapter.ts       ← 当前 adapter.ts 改名，class 改 ClaudePtyAdapter
├── pty.ts               ← 不动
├── pty-pool.ts          ← 不动
├── pty-session.ts       ← 不动
├── jsonl-path.ts        ← 不动
├── jsonl-reader.ts      ← 不动
├── jsonl-translate.ts   ← 不动
```

两个 adapter 类都实现 `AgentAdapter`，共享 `types.ts` 的 `AgentRun` / `AgentEvent`。

`ClaudePtyAdapter` = 当前 `ClaudeAdapter` 的内容（改个类名，移到 `pty-adapter.ts`，和原来占位的 `adapter.ts` 再无冲突）。

`ClaudeHeadlessAdapter` = main 原 `ClaudeAdapter`（`spawnProcess` → stream-json lines → `createStreamJsonTranslator` → yield events）。从 git 恢复。

#### `AgentRun` 差异

| 方法 | headless | pty |
|---|---|---|
| `events` | `createEventStream(child, ...)` async generator | `session.runTurn(prompt)` async generator |
| `stop()` | SIGTERM → grace → SIGKILL | `session.terminate(stopGraceMs)` |
| `waitForExit(ms)` | `child.once('exit')` + timeout | always `true`（PTY turn 在 events drain 后已完成） |
| `answerQuestion(a)` | 空返回（no-op stub） | `session.answerAskUserQuestion(a)` |
| `resetIdleCheckpoint()` | 空返回（no-op stub） | `session.resetIdleCheckpoint()` |

消费者已有守卫：
- `if (callbackAuth && handle.run.answerQuestion)` — headless stub 不会触发。
- `ctx.agent.closeSession` — `AgentAdapter` 上已是 `?` 可选方法，headless 不实现。调用方 (`commands/index.ts`) 已写 `ctx.agent.closeSession?.()`。

### 3. Factory

`src/cli/commands/start.ts` 的 adapter 生成逻辑改为：

```
agentKind === 'codex'  → CodexAdapter
agentKind === 'claude' →
  getClaudeDriver(cfg) === 'headless' → ClaudeHeadlessAdapter({ larkChannel })
  getClaudeDriver(cfg) === 'pty'      → ClaudePtyAdapter({ larkChannel })
```

存量配置无 `claudeDriver` → `getClaudeDriver` 返回 `'pty'`，无迁移成本。

### 4. Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/config/schema.ts` | 改 | 追加 `ClaudeDriver` 类型 + `getClaudeDriver` 访问器 |
| `src/agent/claude/adapter.ts` | 重写 | 从 main 恢复 headless 实现，类名 `ClaudeHeadlessAdapter` |
| `src/agent/claude/stream-json.ts` | 恢复 | 从 main 的 git history 恢复，原样 |
| `src/agent/claude/pty-adapter.ts` | 新建 | 当前 `adapter.ts` 内容移入，类名 `ClaudePtyAdapter` |
| `src/agent/index.ts` | 改 | 导出从 `ClaudeAdapter` 改为 `ClaudeHeadlessAdapter` + `ClaudePtyAdapter` |
| `src/cli/commands/start.ts` | 改 | 工厂按 `getClaudeDriver` 二选一 |
| `src/card/config-card.ts` | 改 | 表单加 driver 选项 |

`channel.ts` 不直接 import adapter 类（adapter 通过 `deps.agent: AgentAdapter` 注入），无需改动。

**测试**：

| 文件 | 动作 |
|---|---|
| `tests/unit/agent/claude-stream-json.test.ts` | 恢复（合并时以 modify/delete 冲突被删） |
| `tests/process/claude-adapter.test.ts` | 拆分：headless 部分恢复为 `claude-headless-adapter.test.ts` |
| 所有 PTY 测试（pty-adapter.test.ts 等） | `import { ClaudeAdapter }` → `import { ClaudePtyAdapter }` |
| `tests/unit/agent/adapter-system-prompt-wiring.test.ts` | PTY 用例改 import；headless 用例（spawnProcess 分支）恢复 |
| `tests/helpers/fake-agent.ts` / fake-channel 等 | 按需调整 adapter 构造函数名引用 |

### 5. Non-goals

- headless 不支持 AskUserQuestion——不需要，headless 下 claude 不会发这个事件（`-p` 模式下没有 TUI 交互）。
- 不做「不可用时自动回退」。用户知道自己选了什么。
- CodexAdapter 不受影响，仍然是独立路径。

### 6. Risks

- **headless 适配 `RunHandle` 接口**：当前 `channel.ts`、`active-runs.ts`、`run-flow.ts` 经过 PTY 分支的 `answerQuestion` / `resetIdleCheckpoint` / `closeSession` 扩展。headless 加 no-op stub 即可，现存守卫代码不会走进这些路径。唯一需仔细的是 `channel.ts` 的 `waitForExit` 语义应和 main 一致（真正等子进程退出）。
- **stream-json 和 token footer / usage ledger**：headless 的 `createStreamJsonTranslator` 产出 `usage` 事件（`inputTokens` / `outputTokens` / `costUsd`），和 PTY 的 `jsonl-translate` 产出同形状——ledger、footer 的消费代码不改。
- **CSS / 模板文件**：无改动。config-card 只是多一行选项。
