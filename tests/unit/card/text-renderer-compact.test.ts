import { describe, expect, it } from 'vitest';
import { renderText } from '../../../src/card/text-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

const FIVE_TOOLS: AgentEvent[] = [
  { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
  { type: 'tool_result', id: 't1', output: '/repo', isError: false },
  { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/a.ts' } },
  { type: 'tool_result', id: 't2', output: 'a', isError: false },
  { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
  { type: 'tool_result', id: 't3', output: 'ok', isError: false },
  { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'pnpm test' } },
  { type: 'tool_result', id: 't4', output: 'pass', isError: false },
  { type: 'tool_use', id: 't5', name: 'Glob', input: { pattern: '*.ts' } },
  { type: 'tool_result', id: 't5', output: 'list', isError: false },
];

describe('renderText compact mode', () => {
  it('keeps user text inline but emits exactly one tail summary regardless of tool/text interleaving', () => {
    // Real-world pattern: claude alternates tool → text → tool → text, which
    // previously produced one "1 个工具调用" line per tool. Compact mode must
    // collapse all of them into a single tail summary so the chat reads
    // cleanly.
    const state = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Skill', input: { command: 'etrade logs +query' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'text', delta: '我来查 shared_pay_channel 的日志。' },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'etrade logs +query --service ...' } },
      { type: 'tool_result', id: 't2', output: 'no hits', isError: false },
      { type: 'text', delta: 'error 日志没命中,扩大时间范围。' },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'etrade logs +query --span 7d' } },
      { type: 'tool_result', id: 't3', output: 'no hits', isError: false },
      { type: 'text', delta: '7 天也没记录。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const text = renderText(state, { toolDisplay: 'compact' });
    // No inline tool lines anywhere.
    const inlineToolLines = text.split('\n').filter((l) => /^>\s+(⏳|✅|❌)\s\*\*/.test(l));
    expect(inlineToolLines).toHaveLength(0);
    // Exactly one summary line.
    const summaryLines = text.split('\n').filter((l) => l.includes('🧰'));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toMatch(/3 个工具调用/);
    expect(summaryLines[0]).toContain('Skill');
    expect(summaryLines[0]).toContain('Bash');
    // User-visible text is preserved in order.
    expect(text.indexOf('我来查')).toBeLessThan(text.indexOf('没命中'));
    expect(text.indexOf('没命中')).toBeLessThan(text.indexOf('没记录'));
  });

  it('shows the currently running tool alongside the finished count', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 't1', output: '/repo', isError: false },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 't2', output: 'a', isError: false },
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'pnpm test' } },
      // No tool_result for t3: this one is running.
    ]);
    const text = renderText(state, { toolDisplay: 'compact' });
    // Should mention progress: 2 finished + 1 running.
    expect(text).toMatch(/2 个/);
    expect(text).toMatch(/正在/);
    expect(text).toContain('pnpm test');
  });

  it('emits no summary line when no tools were used', () => {
    const state = stateFrom([
      { type: 'text', delta: '这是一个纯文本回答' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const text = renderText(state, { toolDisplay: 'compact' });
    expect(text).not.toContain('🧰');
    expect(text).toContain('这是一个纯文本回答');
  });

  it('keeps a singleton tool group quiet too — no "1 个工具调用" noise', () => {
    // The original UX failure mode: a single tool in its own group used to
    // render as "🧰 1 个工具调用: Skill", which was MORE verbose than the
    // full-mode equivalent. Now it should still produce the tail summary,
    // not a per-group inline summary.
    const state = stateFrom([
      { type: 'tool_use', id: 't1', name: 'Skill', input: { command: 'do thing' } },
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      { type: 'text', delta: '我来查日志。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const text = renderText(state, { toolDisplay: 'compact' });
    const summaryLines = text.split('\n').filter((l) => l.includes('🧰'));
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toContain('Skill');
  });

  it('full mode (and default) still renders one line per tool', () => {
    const state = stateFrom([...FIVE_TOOLS, { type: 'done', terminationReason: 'normal' }]);
    const compact = renderText(state, { toolDisplay: 'compact' });
    const full = renderText(state, { toolDisplay: 'full' });
    const defaultRender = renderText(state);
    expect(defaultRender).toBe(full);
    // Full keeps a line per tool, compact collapses.
    const fullLineCount = full.split('\n').filter((l) => l.startsWith('> ')).length;
    const compactLineCount = compact.split('\n').filter((l) => l.startsWith('> ')).length;
    expect(fullLineCount).toBeGreaterThanOrEqual(5);
    expect(compactLineCount).toBeLessThan(fullLineCount);
  });

  it('hide mode emits no tool lines at all', () => {
    const state = stateFrom([
      { type: 'text', delta: 'before' },
      ...FIVE_TOOLS,
      { type: 'text', delta: 'after' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const text = renderText(state, { toolDisplay: 'hide' });
    expect(text).not.toMatch(/Bash|Read|Edit|Glob/);
    expect(text).toContain('before');
    expect(text).toContain('after');
  });
});
