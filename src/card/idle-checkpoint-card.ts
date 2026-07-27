import type { ToolInFlight, TodoSnapshot, TurnSnapshot } from '../agent/types';

/**
 * Render a "long-running turn check-in" card when PtySession has emitted an
 * `idle_checkpoint` event. The card surfaces what claude was last doing
 * (current sub-task from TaskUpdate, in-flight tools with human-readable
 * labels, latest assistant text snippet, timing) and offers two callback
 * buttons:
 *   - **继续等待**: callback payload `{ __ac: { action: 'wait' } }` — the
 *     dispatcher routes this to `run.resetIdleCheckpoint()` so the next
 *     checkpoint fires after the *first* backoff threshold again, not the
 *     already-extended one.
 *   - **立即终止**: callback payload `{ __ac: { action: 'terminate' } }` —
 *     routed to `run.stop()` (which sends ESC + waits the grace window;
 *     PtySession yields `done(interrupted)` and the run ends cleanly).
 *
 * The card carries `__bridge_cb: true` + a signed `bridge_token` so the
 * existing callback verifier picks it up exactly like AskUserQuestion cards.
 */
export interface IdleCheckpointCardInput {
  snapshot: TurnSnapshot;
  idleMs: number;
  /** 1-based: 1st checkpoint after first threshold, 2nd after backoff, etc. */
  checkpointNumber: number;
  bridgeToken: string;
  /** Override for tests; defaults to Date.now(). */
  now?: () => number;
}

export function renderIdleCheckpointCard(input: IdleCheckpointCardInput): object {
  const { snapshot, idleMs, checkpointNumber, bridgeToken } = input;
  const now = (input.now ?? Date.now)();

  const headerSuffix = checkpointNumber > 1 ? ` (第 ${checkpointNumber} 次)` : '';
  const heading = `**⏳ 任务长时间无响应**${headerSuffix}`;

  const elements: object[] = [{ tag: 'markdown', content: heading }];

  if (snapshot.todos) {
    elements.push({ tag: 'markdown', content: renderTodos(snapshot.todos) });
  }

  const activityLines: string[] = [];
  if (snapshot.inFlightTools.length > 0) {
    activityLines.push('**当前操作**');
    for (const tool of snapshot.inFlightTools) {
      activityLines.push(`• ${renderTool(tool, now)}`);
    }
  } else if (snapshot.lastCompletedTool) {
    activityLines.push(
      `**最近完成**：${snapshot.lastCompletedTool.label} (${formatDelta(now - snapshot.lastCompletedTool.startedAt)})`,
    );
  }
  if (snapshot.lastTextTail) {
    const sinceLast = formatDelta(now - snapshot.lastEntryAt);
    activityLines.push(
      `**最后输出**（${sinceLast} 前）：${truncate(snapshot.lastTextTail.replace(/\s+/g, ' '), 200)}`,
    );
  }
  if (activityLines.length > 0) {
    elements.push({ tag: 'markdown', content: activityLines.join('\n') });
  }

  elements.push({
    tag: 'markdown',
    content:
      `已运行 ${formatDelta(now - snapshot.turnStartedAt)}，` +
      `静默 ${formatDelta(idleMs)}` +
      ` · ${snapshot.entriesSeen} 条 JSONL` +
      (snapshot.tokens.outputTokens
        ? ` · ${snapshot.tokens.outputTokens} 输出 tokens`
        : ''),
  });

  elements.push({
    tag: 'column_set',
    columns: [
      { tag: 'column', elements: [waitButton(bridgeToken, checkpointNumber)] },
      { tag: 'column', elements: [terminateButton(bridgeToken, checkpointNumber)] },
    ],
  });

  return {
    schema: '2.0',
    config: { summary: { content: '任务长时间无响应' } },
    body: { elements },
  };
}

function renderTodos(todos: TodoSnapshot): string {
  const pct = todos.total > 0 ? Math.round((todos.completed / todos.total) * 100) : 0;
  const barWidth = 12;
  const filled = Math.round((todos.completed / Math.max(1, todos.total)) * barWidth);
  const bar = '▰'.repeat(filled) + '▱'.repeat(barWidth - filled);
  const lines: string[] = [
    `**进度：${todos.completed} / ${todos.total}** · ${bar} ${pct}%`,
  ];
  if (todos.inProgressIdx !== null) {
    const current = todos.items[todos.inProgressIdx];
    if (current) {
      lines.push(`**当前子任务**：${current.activeForm ?? current.content}`);
    }
  }
  return lines.join('\n');
}

function renderTool(tool: ToolInFlight, now: number): string {
  const dur = formatDelta(now - tool.startedAt);
  return `${tool.label} · 已运行 ${dur}`;
}

function waitButton(bridgeToken: string, checkpointNumber: number): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏳ 继续等待' },
    type: 'primary',
    behaviors: [
      {
        type: 'callback',
        value: {
          __bridge_cb: true,
          bridge_token: bridgeToken,
          __ac: { action: 'wait', checkpointNumber },
        },
      },
    ],
  };
}

function terminateButton(bridgeToken: string, checkpointNumber: number): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 立即终止' },
    type: 'danger',
    behaviors: [
      {
        type: 'callback',
        value: {
          __bridge_cb: true,
          bridge_token: bridgeToken,
          __ac: { action: 'terminate', checkpointNumber },
        },
      },
    ],
  };
}

function formatDelta(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m} 分 ${rs} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
