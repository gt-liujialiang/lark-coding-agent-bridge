import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  hideFinishedTools,
  initialState,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

describe('running tool line in markdown text mode', () => {
  it('shows the running tool as a single header line without input detail', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'git log --oneline --graph --all --decorate' },
      },
    ]);

    const text = renderText(state);
    expect(text).toContain('⏳ **Bash** — git log --oneline --graph --all --decorate');
    // One line only — no fenced command block under the header.
    expect(text).not.toContain('```');
  });

  it('suppresses the generic tool_running footer while a running tool line is visible', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);

    expect(state.footer).toBe('tool_running');
    expect(renderText(state)).not.toContain('正在调用工具');
  });

  it('shows the thinking footer in the gap after a tool finishes', () => {
    // After the last tool_result the reducer flips the footer to thinking —
    // the model is digesting the result until the next event.
    const withFinishedTool = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
    ]);
    const state = {
      ...withFinishedTool,
      blocks: withFinishedTool.blocks.filter((b) => b.kind !== 'tool'),
    };

    const text = renderText(state);
    expect(text).toContain('正在思考');
    expect(text).not.toContain('正在调用工具');
  });

  it('collapses the tool to a one-liner once it finishes', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
      { type: 'tool_result', id: 'tool-1', output: 'clean', isError: false },
    ]);

    expect(renderText(state)).toContain('✅ **Bash** — git status');
  });
});

describe('compact activity card (showToolCalls=false)', () => {
  const compact = { compactActivity: true };

  it('shows a plain status line (no 执行详情 panel) reflecting the current activity', () => {
    const thinking = JSON.stringify(renderCard(stateFrom([{ type: 'thinking', delta: 'x' }]), compact));
    expect(thinking).toContain('🧠 正在思考');
    expect(thinking).not.toContain('执行详情');
    expect(thinking).not.toContain('collapsible_panel');

    const tooling = JSON.stringify(
      renderCard(stateFrom([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }]), compact),
    );
    expect(tooling).toContain('🧰 正在调用工具');

    const texting = JSON.stringify(renderCard(stateFrom([{ type: 'text', delta: 'y' }]), compact));
    expect(texting).toContain('✍️ 正在输出');
  });

  it('shows no tool-call history or reasoning body', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'git log --oneline' } },
    ]);

    const card = JSON.stringify(renderCard(state, compact));
    expect(card).not.toContain('hidden reasoning');
    expect(card).not.toContain('/repo/a.ts');
    expect(card).not.toContain('git log --oneline');
  });

  it('renders a token-usage footer once usage arrives', () => {
    const state = stateFrom([
      { type: 'text', delta: 'answer' },
      { type: 'usage', inputTokens: 1234, outputTokens: 856, costUsd: 0.0312 },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state, compact));
    expect(card).toContain('📊');
    expect(card).toContain('输入 1.2k');
    expect(card).toContain('输出 856');
    expect(card).toContain('$0.03');
  });

  it('omits the token footer when no usage was reported', () => {
    const state = stateFrom([
      { type: 'text', delta: 'answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    expect(JSON.stringify(renderCard(state, compact))).not.toContain('📊');
  });

  it('renders only the answer plus token footer once the run is done', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'final answer' },
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state, compact));
    expect(card).toContain('final answer');
    expect(card).toContain('📊');
    expect(card).not.toContain('Bash');
    expect(card).not.toContain('正在'); // no running status line after done
  });

  it('keeps the stop button content-sized at the bottom-left', () => {
    const card = renderCard(initialState, compact) as { body: { elements: unknown[] } };
    const last = card.body.elements[card.body.elements.length - 1] as {
      tag?: string;
      columns?: Array<{ width?: string }>;
    };
    expect(last.tag).toBe('column_set');
    // Single auto-width column → button hugs its label on the left.
    expect(last.columns).toHaveLength(1);
    expect(last.columns?.[0]?.width).toBe('auto');
  });
});

describe('running tool panel in card mode', () => {
  it('titles the running tool panel with a click-to-expand hint', () => {
    const state = stateFrom([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'git log --oneline --graph' },
      },
    ]);

    const card = JSON.stringify(renderCard(state));
    expect(card).toContain('🧰 调用工具: **Bash** — git log --oneline --graph（点击查看详情）');
    // Full command still available in the collapsible body (JSON-escaped).
    expect(card).toContain('**Command**\\n```bash\\ngit log --oneline --graph\\n```');
  });

  it('keeps the plain ✅ header once the tool finishes', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
    ]);

    const card = JSON.stringify(renderCard(state));
    expect(card).toContain('✅ **Bash** — pwd');
    expect(card).not.toContain('点击查看详情');
  });

  it('suppresses the generic tool_running footer while a running tool panel is visible', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);

    // The collapsed-preview `config.summary` may still say 正在调用工具 —
    // only the card body must not repeat it as a footer element.
    const card = renderCard(state) as { body: { elements: object[] } };
    expect(JSON.stringify(card.body.elements)).not.toContain('正在调用工具');
  });
});

describe('footer after tool completion', () => {
  it('falls back to thinking when the last running tool finishes', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
    ]);

    // Between tool completion and the next event the model is digesting the
    // result — that's thinking, not "calling a tool".
    expect(state.footer).toBe('thinking');
  });

  it('stays tool_running while another tool is still in flight', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/a' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
    ]);

    expect(state.footer).toBe('tool_running');
  });

});

describe('hideFinishedTools (showToolCalls=false filter)', () => {
  it('keeps every tool block while the run is live, finished ones included', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'working on it' },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
    ]);

    // Terminal is still 'running' — nothing may vanish mid-run.
    expect(hideFinishedTools(state)).toEqual(state);
  });

  it('drops all tool blocks once the run reaches a terminal state', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const filtered = hideFinishedTools(state);
    expect(filtered.blocks.some((b) => b.kind === 'tool')).toBe(false);
    expect(filtered.blocks.some((b) => b.kind === 'text')).toBe(true);
  });
});
