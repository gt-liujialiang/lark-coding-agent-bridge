import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { runningToolPanelTitle, toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  /**
   * Compact mode (`showToolCalls: false`): no tool-call history, no
   * standalone reasoning panel, no switching status line (switching elements
   * make the card flicker). While running, one STATIC collapsed panel
   * (「📋 执行详情」) holds the whole process — reasoning + tool list — for
   * on-demand expansion; the finished card is just the answer.
   */
  compactActivity?: boolean;
  /**
   * When set, a 👍 N / 👎 M vote row is shown once the run finishes normally,
   * guiding people to rate the reply. `entryId` rides on the button so a click
   * is attributed; `counts` are the current tallies (shared with native emoji
   * reactions — one vote per person). Buttons persist; only the counts change.
   */
  feedback?: { entryId: string; counts?: { up: number; down: number } };
  /**
   * Force `config.streaming_mode: false`. Set for managed entity cards, which
   * update via full-card `updateCardById` replaces (not element-level stream
   * APIs). Leaving streaming_mode on would put the card in a streaming
   * lifecycle that only `card.settings` can exit — so post-run updates (final
   * state, 👍/👎 counts) wouldn't render. Full replaces don't need it.
   */
  staticMode?: boolean;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  if (!options.compactActivity && state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else if (!options.compactActivity) {
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    // Both modes now show the same lightweight status line. In compact mode
    // there are no tool panels, so nothing duplicates it; in full mode we
    // skip it only when a running tool panel already says the same thing.
    const runningToolVisible =
      !options.compactActivity &&
      state.blocks.some((b) => b.kind === 'tool' && b.tool.status === 'running');
    if (state.footer && !(state.footer === 'tool_running' && runningToolVisible)) {
      elements.push(footerStatus(state.footer));
    }
    elements.push(stopButtonRow(options));
  }

  const usageNote = usageFooter(state.usage);
  if (usageNote) elements.push(usageNote);

  if (options.feedback && state.terminal === 'done') {
    elements.push(feedbackRow(options.feedback));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running' && !options.staticMode,
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

/** 👍 N / 👎 M guidance row on a finished card. Buttons persist after a click
 * and just update their count (one vote per person, shared with native emoji
 * reactions via the ledger). Payload is unsigned `{cmd:'fb', arg, fb_id}`;
 * the dispatcher gates it on the same access check as any card action. */
function feedbackRow(feedback: NonNullable<RunCardRenderOptions['feedback']>): object {
  const counts = feedback.counts ?? { up: 0, down: 0 };
  const btn = (arg: 'up' | 'down', text: string): object => ({
    tag: 'column',
    width: 'auto',
    elements: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        type: 'default',
        size: 'tiny',
        behaviors: [{ type: 'callback', value: { cmd: 'fb', arg, fb_id: feedback.entryId } }],
      },
    ],
  });
  return {
    tag: 'column_set',
    horizontal_spacing: 'small',
    columns: [btn('up', `👍 ${counts.up}`), btn('down', `👎 ${counts.down}`)],
  };
}

/** Bottom-of-card token usage line, e.g. `📊 tokens 输入 1.2k · 输出 856 · $0.03`. */
function usageFooter(usage: RunState['usage']): object | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`输入 ${formatTokens(usage.inputTokens)}`);
  if (usage.outputTokens !== undefined) parts.push(`输出 ${formatTokens(usage.outputTokens)}`);
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
  if (parts.length === 0) return undefined;
  return noteMd(`📊 tokens ${parts.join(' · ')}`);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: tool.status === 'running' ? runningToolPanelTitle(tool) : toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButtonRow(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  // Auto-width column keeps the button content-sized at the bottom-left.
  return {
    tag: 'column_set',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⏹ 终止' },
            type: 'danger',
            size: 'tiny',
            behaviors: [{ type: 'callback', value }],
          },
        ],
      },
    ],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
