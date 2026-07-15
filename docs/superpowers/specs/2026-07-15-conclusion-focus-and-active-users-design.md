# 结论聚焦渲染 + 活跃用户台账 设计

日期：2026-07-15
状态：已批准，待实现

## 背景与动机

机器人把飞书用户消息桥接到本地 coding agent（Claude Code / Codex），agent 的输出以交互卡片流式回到飞书。当前卡片渲染（`src/card/run-renderer.ts`）：

- 「🧠 思考」reasoning 面板已是折叠面板（思考中展开、结束后折叠）。
- 工具调用 ≥3 个时折叠为摘要。
- assistant 正文文本全部平铺 markdown 展示。

痛点：在排查/调查类回答里，「过程 + 证据 + 中间数据」（SQL、订单表格、路由记录等）和「结论 / 根因」**都在 agent 的同一段正文文本里**。用户想一眼看到结论，过程折叠起来。已有的 reasoning 折叠面板解决不了这个问题，因为要切分的内容在正文里。

同时，需要一个本地台账，记录有多少活跃用户（在飞书里向机器人提问的人）。

## 目标

1. 卡片能把 agent 正文里的「结论」醒目置顶，把「过程与证据」折叠 —— 且此交互样式**可选**（配置开关，默认关闭，不影响老用户）。
2. 本地记录活跃用户台账，并提供飞书内 `/stats` 管理员命令查看汇总。

## 非目标

- 不改 `markdown` / `text` 回复模式（它们没有折叠面板能力）；本特性仅作用于 `card` 模式。
- 不做事后 LLM 二次总结（成本/延迟/幻觉）。
- 不强制所有回答都用「排查模板」；结构由 agent 自选是否启用。
- 台账不做跨 profile 全局聚合、不做上报外部系统；仅本地、按 profile 隔离。

## 设计决策（已确认）

- 结论识别：**标记约定 + 自动降级**。给 agent 加软约定输出结论标记；渲染器按标记切分；无标记则完全按现状渲染。不额外做启发式词扫。
- 结论位置：**置顶**。
- 台账：**本地文件 + `/stats` 命令**。
- 结论标记词：`## ✅ 结论`，检测 `结论 / 根因 / 总结`。
- 配置开关：**默认关闭**。
- 台账文件：**按 profile 隔离**（每个 profile 一份）。

## 组件设计

### 组件 1 — 结论标记约定（agent 侧）

**文件**：`src/agent/bridge-system-prompt.ts`

在 `BRIDGE_SYSTEM_PROMPT` 末尾加一段输出约定小节，大意：

> 当你的回答是排查 / 调查类，或有一个明确的结论时，把关键结论放在一个 `## ✅ 结论`（可合并「根因」）标题下，过程、证据、中间数据（查询、表格、日志等）放在该标题**之前**。日常简单回答（改错别字、闲聊、单行答复）不需要这个结构。这只是展示建议，由你判断是否适用。

要点：

- 措辞为「建议」而非强制，避免污染简单回答。
- 标题词固定为 `结论`（可含根因），与渲染器检测正则对齐。
- 这段是 append-system-prompt 注入，agent 未遵守时渲染器自动降级，不会出错。

### 组件 2 — 结论聚焦渲染（卡片侧）

**文件**：`src/card/run-renderer.ts`

`renderCard(state, options)` 增加一个 flag（经 `RunCardRenderOptions.conclusionFocus?: boolean` 传入）。

**触发条件（三者同时满足才切分）**：

1. `conclusionFocus === true`（配置开关打开）。
2. `state.terminal === 'done'`（run 已正常结束；运行中 / 中断 / 超时 / 出错都不切分，维持现状）。
3. 在 assistant 正文文本里检测到结论标记。

**检测正则**：`/^#{1,6}\s*(?:✅\s*)?(?:结论|根因|总结)/m`
取**最后一个**匹配位置作为切分点（避免正文中前面偶然出现「结论」字样时误切）。

**切分与渲染**：

- 把所有 `text` block 的内容按出现顺序拼成完整正文，在最后一个标记处切成 `过程文本`（标记前）与 `结论文本`（标记及其后）。
- 渲染顺序（自上而下）：
  1. **结论文本**：普通 markdown，醒目平铺，**不截断**（置顶）。
  2. 折叠面板「🔍 排查过程与证据」：内含 `过程文本` 的 markdown（`text_size: notation`，超长按现有 `REASONING_MAX` 量级截断，防超 30KB 元素上限）。
  3. reasoning 思考面板：折叠（复用现有 `reasoningPanel`）。
  4. 工具调用组：折叠（复用现有 `renderToolGroup` finalized 分支）。
  5. terminal note（如「未返回内容」等）保持现有逻辑。

**降级**：条件不满足时，走现有渲染路径，行为完全不变。

**边界情况**：

- 有标记但 `过程文本` 为空（结论就是全部正文）→ 不生成过程面板，只置顶结论。
- 多个标记 → 取最后一个。
- 运行中（streaming）→ 现状渲染（此时标记可能还没输出完）。

### 组件 3 — 配置开关

**文件**：`src/config/schema.ts`

- `AppPreferences` 增加：
  ```ts
  /**
   * 是否启用「结论聚焦」渲染：把 agent 正文里 `## 结论/根因` 标记后的
   * 内容醒目置顶，其余过程/证据折叠。默认 false。仅 card 模式生效。
   */
  conclusionFocus?: boolean;
  ```
- 增加 getter，遵循现有风格：
  ```ts
  /** Resolve the conclusion-focus preference. Default false. */
  export function getConclusionFocus(cfg: AppConfig): boolean {
    return cfg.preferences?.conclusionFocus === true;
  }
  ```

**文件**：`src/card/config-card.ts`

- `ConfigFormOpts` 增加 `conclusionFocus: boolean`。
- 表单里加一个 toggle（label：「推理过程折叠 · 结论聚焦」），`initial_option` 取 `conclusionFocus ? 'on' : 'off'`，与 `showToolCalls` 的写法一致。
- 保存后展示卡里加一行：`**结论聚焦**:\`on/off\``。

**渲染调用链**：找到 `renderCard` 的调用处（`run-flow.ts` / `dispatcher.ts` 等），把 `getConclusionFocus(cfg)` 作为 `options.conclusionFocus` 传入。`/config` 表单读写处同步新增字段的解析与持久化。

### 组件 4 — 活跃用户台账

**新文件**：`src/observability/active-users.ts`

一个并发安全的小 store：

```ts
export interface ActiveUserRecord {
  openId: string;
  name?: string;
  chatId: string;       // 最近一次提问所在 chat
  chatType: string;     // p2p | group | ...
  firstSeenAt: string;  // ISO
  lastSeenAt: string;   // ISO
  messageCount: number;
}
```

- `recordActiveUser(filePath, entry)`：用 `proper-lockfile`（已是依赖）锁文件 → 读 JSON → upsert（按 `openId`：存在则 `messageCount++`、更新 `name/chatId/chatType/lastSeenAt`；不存在则新建、`firstSeenAt=lastSeenAt=now`）→ 写回。文件不存在或损坏时以空表兜底。
- `readActiveUsers(filePath): ActiveUserRecord[]`：只读加载，损坏时返回空数组。
- 时间戳由调用方注入（便于测试），或在内部取 `new Date().toISOString()`。

**文件**：`src/config/app-paths.ts`

- `AppPaths` 增加 `activeUsersFile: string`，`resolveAppPaths` 里 `join(profileDir, 'active-users.json')`。

**文件**：`src/bot/channel.ts`

- 在 intake、access 通过之后（约 L546 之后、命令分发之前）埋点：仅当 `senderType === 'user'`（跳过 bot；复用现有 `classifySender` 之类逻辑）时调用 `recordActiveUser`。
- 记录失败只 `log.warn`，绝不阻塞消息处理（fire-and-forget + catch）。

**文件**：`src/commands/index.ts`

- 新增 `/stats` handler，注册进 `handlers` 与 `ADMIN_COMMANDS`。
- 行为：读台账 → 回一张汇总卡：总活跃用户数、Top N 提问者（按 `messageCount`）、最近活跃（按 `lastSeenAt`）。空台账时回友好提示。

## 数据流

```
飞书消息
  → channel.ts intake（access 通过）
      ├─ 若 senderType=user → recordActiveUser(activeUsersFile)   [组件4]
      └─ tryHandleCommand → /stats 读台账回卡                     [组件4]
  → agent run（注入 BRIDGE_SYSTEM_PROMPT 含结论约定）              [组件1]
  → 流式事件 reduce 成 RunState
  → renderCard(state, { conclusionFocus: getConclusionFocus(cfg) })[组件2/3]
      └─ terminal=done 且开关开且有标记 → 结论置顶 + 过程折叠
         否则 → 现状渲染（降级）
```

## 错误处理

- 渲染切分：正则无匹配 / 正文为空 → 降级到现状渲染，不抛错。
- 台账写：加锁失败、文件损坏 → 记 warn、以空表兜底，不影响消息主流程。
- `/stats`：空台账 → 回「暂无活跃用户记录」。
- 配置：`conclusionFocus` 缺省 → `false`。

## 测试

- `run-renderer`：有标记切分正确 / 无标记降级 / 多标记取最后 / 过程文本为空 / 运行中不切分 / 开关关闭时不切分。
- `getConclusionFocus`：缺省 false、显式 true/false。
- `active-users` store：新建、累加 messageCount、更新 name/lastSeenAt、损坏文件兜底、并发写（顺序调用验证不丢更新）。
- `config-card`：新增 toggle 的初始值渲染（可选，跟随现有 config-card 测试风格）。

## 文件影响清单

| 文件 | 改动 |
| --- | --- |
| `src/agent/bridge-system-prompt.ts` | 加结论约定小节 |
| `src/card/run-renderer.ts` | 结论聚焦切分渲染 + `RunCardRenderOptions.conclusionFocus` |
| `src/config/schema.ts` | `conclusionFocus` 字段 + `getConclusionFocus` |
| `src/card/config-card.ts` | 新增 toggle + 保存卡展示行 |
| `src/config/app-paths.ts` | `activeUsersFile` 路径 |
| `src/observability/active-users.ts` | 新建：台账 store |
| `src/bot/channel.ts` | intake 埋点 + renderCard 传 flag |
| `src/commands/index.ts` | `/stats` 命令 + 调用处传 conclusionFocus |
| `tests/**` | 对应单测 |
