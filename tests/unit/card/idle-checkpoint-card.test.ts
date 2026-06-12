import { describe, expect, it } from 'vitest';
import { renderIdleCheckpointCard } from '../../../src/card/idle-checkpoint-card.js';
import type { TurnSnapshot } from '../../../src/agent/types.js';

function baseSnapshot(over: Partial<TurnSnapshot> = {}): TurnSnapshot {
  const base = 1_000_000_000_000;
  return {
    turnStartedAt: base,
    lastEntryAt: base + 60_000,
    entriesSeen: 42,
    inFlightTools: [],
    lastCompletedTool: null,
    lastTextTail: '',
    todos: null,
    tokens: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 100 },
    ...over,
  };
}

function flattenMarkdown(card: object): string {
  const elements = ((card as { body: { elements: object[] } }).body.elements);
  return elements
    .filter((e) => (e as { tag: string }).tag === 'markdown')
    .map((e) => (e as { content: string }).content)
    .join('\n');
}

function buttons(card: object): Array<{ label: string; value: Record<string, unknown> }> {
  const elements = ((card as { body: { elements: object[] } }).body.elements);
  const out: Array<{ label: string; value: Record<string, unknown> }> = [];
  for (const el of elements) {
    if ((el as { tag: string }).tag === 'column_set') {
      const cols = (el as { columns: Array<{ elements: object[] }> }).columns;
      for (const col of cols) {
        for (const btn of col.elements) {
          if ((btn as { tag: string }).tag === 'button') {
            const b = btn as { text: { content: string }; behaviors: Array<{ value: Record<string, unknown> }> };
            out.push({ label: b.text.content, value: b.behaviors[0]!.value });
          }
        }
      }
    }
  }
  return out;
}

describe('renderIdleCheckpointCard', () => {
  it('produces both [继续等待] and [立即终止] buttons with __ac routing + bridge_token', () => {
    const card = renderIdleCheckpointCard({
      snapshot: baseSnapshot(),
      idleMs: 12 * 60_000,
      checkpointNumber: 1,
      bridgeToken: 'tok-xyz',
      now: () => 1_000_000_000_000 + 23 * 60_000,
    });
    const btns = buttons(card);
    expect(btns.map((b) => b.label)).toEqual(['⏳ 继续等待', '⏹ 立即终止']);
    expect(btns.every((b) => b.value.__bridge_cb === true)).toBe(true);
    expect(btns.every((b) => b.value.bridge_token === 'tok-xyz')).toBe(true);
    expect(btns[0]!.value.__ac).toEqual({ action: 'wait', checkpointNumber: 1 });
    expect(btns[1]!.value.__ac).toEqual({ action: 'terminate', checkpointNumber: 1 });
  });

  it('renders progress bar + current sub-task when todos are present', () => {
    const card = renderIdleCheckpointCard({
      snapshot: baseSnapshot({
        todos: {
          total: 5,
          completed: 2,
          inProgressIdx: 2,
          items: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'completed' },
            { content: 'c', status: 'in_progress', activeForm: '加 idle deadline' },
            { content: 'd', status: 'pending' },
            { content: 'e', status: 'pending' },
          ],
        },
      }),
      idleMs: 12 * 60_000,
      checkpointNumber: 1,
      bridgeToken: 'tok',
      now: () => 1_000_000_000_000 + 60_000,
    });
    const md = flattenMarkdown(card);
    expect(md).toContain('进度：2 / 5');
    expect(md).toContain('40%');
    // 12-wide bar at 40% → 5 filled / 7 empty
    expect(md).toMatch(/▰{5}▱{7}/);
    expect(md).toContain('**当前子任务**：加 idle deadline');
  });

  it('includes in-flight tool labels and the last text tail', () => {
    const start = 1_000_000_000_000;
    const card = renderIdleCheckpointCard({
      snapshot: baseSnapshot({
        lastEntryAt: start + 60_000,
        inFlightTools: [
          { id: 't1', name: 'Bash', label: 'Bash · pnpm test:unit', startedAt: start + 30_000 },
        ],
        lastTextTail: 'running tests now — three failing, retrying...',
      }),
      idleMs: 9 * 60_000,
      checkpointNumber: 2,
      bridgeToken: 'tok',
      now: () => start + 10 * 60_000,
    });
    const md = flattenMarkdown(card);
    expect(md).toContain('当前操作');
    expect(md).toContain('Bash · pnpm test:unit');
    expect(md).toContain('最后输出');
    expect(md).toContain('running tests now');
    // checkpoint number 2 → header should call it out
    expect(md).toContain('(第 2 次)');
  });

  it('shows last completed tool when nothing is currently in flight', () => {
    const start = 1_000_000_000_000;
    const card = renderIdleCheckpointCard({
      snapshot: baseSnapshot({
        lastEntryAt: start + 60_000,
        inFlightTools: [],
        lastCompletedTool: {
          id: 't0',
          name: 'Edit',
          label: 'Edit · src/foo.ts',
          startedAt: start + 50_000,
        },
      }),
      idleMs: 5 * 60_000,
      checkpointNumber: 1,
      bridgeToken: 'tok',
      now: () => start + 6 * 60_000,
    });
    expect(flattenMarkdown(card)).toContain('**最近完成**：Edit · src/foo.ts');
  });
});
