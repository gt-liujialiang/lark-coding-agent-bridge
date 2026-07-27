import type { Block, RunState, ToolEntry } from './run-state';
import type { ToolDisplayMode } from './run-renderer';
import { toolHeaderText } from './tool-render';

export interface RenderTextOptions {
  /**
   * Tool-call rendering mode for the markdown / text reply path.
   *   - `full` (default): one quoted line per tool (existing behavior)
   *   - `compact`: collapse contiguous tool calls to a single summary line
   *     (count + names; the running tool is surfaced separately so the user
   *     still sees what's happening right now)
   *   - `hide`: drop tool blocks entirely
   *
   * In text mode `full` was previously the only meaningful rendering — N
   * tools produced N lines. `compact` is what users expect to be visibly
   * tighter: a 10-tool turn becomes ~1 line instead of 10.
   */
  toolDisplay?: ToolDisplayMode;
}

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * and `'markdown'` modes where we stream a markdown message instead of a
 * card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState, options: RenderTextOptions = {}): string {
  const parts: string[] = [];
  const toolDisplay: ToolDisplayMode = options.toolDisplay ?? 'full';
  const allTools: ToolEntry[] = [];

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      const trimmed = group.content.trim();
      if (trimmed) parts.push(trimmed);
    } else {
      if (toolDisplay === 'hide') continue;
      if (toolDisplay === 'compact') {
        // Don't render inline. Collect for a single tail summary below so
        // claude's text-tool-text-tool alternation doesn't produce a parade
        // of "1 个工具调用" lines (the very thing compact was supposed to
        // fix).
        allTools.push(...group.tools);
      } else {
        for (const tool of group.tools) parts.push(toolLine(tool));
      }
    }
  }

  if (toolDisplay === 'compact' && allTools.length > 0) {
    parts.push(compactToolSummary(allTools));
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    // A visible "⏳ **Bash** — …" line already says a tool is running;
    // the generic tool_running footer would just repeat it.
    const runningToolVisible = state.blocks.some(
      (b) => b.kind === 'tool' && b.tool.status === 'running',
    );
    if (!(state.footer === 'tool_running' && runningToolVisible)) {
      parts.push(footerLine(state.footer));
    }
  }

  return parts.join('\n\n');
}

interface TextGroup { kind: 'text'; content: string }
interface ToolGroup { kind: 'tools'; tools: ToolEntry[] }
type Group = TextGroup | ToolGroup;

/**
 * Same shape as the run-renderer's grouping: contiguous tool blocks fold
 * into a single ToolGroup so compact mode has the whole burst to summarize.
 * Duplicated rather than imported because run-renderer.ts groupBlocks is
 * a private generator — copying ~10 lines is cheaper than exporting it.
 */
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

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 * Deliberately one line even while running — the header's 80-char input
 * summary is the whole "detail"; full inputs live in the file log.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

/**
 * Compact one-liner for a contiguous tool group.
 *
 * All-finished group:
 *   `> 🧰 5 个工具调用: Bash, Read, Edit, Bash, Glob`
 * Group with a running tool at the tail (the common "agent is currently
 * working" state):
 *   `> 🧰 已运行 2 个 · 正在: ⏳ **Bash** — pnpm test`
 *
 * The running case surfaces what claude is doing right now (file/command
 * name) so the user still has live progress visibility even though the
 * earlier tools collapsed.
 */
function compactToolSummary(tools: ToolEntry[]): string {
  if (tools.length === 0) return '';
  const last = tools[tools.length - 1]!;
  const lastRunning = last.status === 'running';
  if (lastRunning) {
    const finishedCount = tools.length - 1;
    if (finishedCount === 0) {
      return `> ${toolHeaderText(last)}`;
    }
    return `> 🧰 已运行 ${finishedCount} 个 · 正在: ${toolHeaderText(last)}`;
  }
  const names = tools.map((t) => t.name).join(', ');
  return `> 🧰 ${tools.length} 个工具调用: ${names}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
