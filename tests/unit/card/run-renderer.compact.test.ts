import { describe, expect, it } from 'vitest';
import {
  finalReplyText,
  renderCard,
  SHORT_REPLY_MAX,
} from '../../../src/card/run-renderer.js';
import {
  initialState,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

const LONG_TEXT = '库存扣减失败的排查过程如下。'.repeat(20); // > SHORT_REPLY_MAX

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

function compact(state: RunState, summary?: string): unknown {
  return normalizeCard(renderCard(state, { style: 'compact', summary }));
}

describe('compact card renderer', () => {
  it('running with no tool shows thinking status + stop button only', () => {
    expect(compact(initialState)).toMatchSnapshot();
    expect(
      compact(stateFrom([{ type: 'thinking', delta: 'looking at logs' }])),
    ).toMatchSnapshot();
  });

  it('running with an active tool shows that tool header line', () => {
    expect(
      compact(
        stateFrom([
          { type: 'text', delta: 'preface' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
        ]),
      ),
    ).toMatchSnapshot();
  });

  it('done with long text shows summary placeholder then real summary', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'root cause hunt' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep err' } },
      { type: 'tool_result', id: 't1', output: 'found', isError: false },
      { type: 'text', delta: LONG_TEXT },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(compact(state)).toMatchSnapshot(); // ⏳ 占位
    expect(compact(state, '扣减失败是 sync_status 未回写导致')).toMatchSnapshot();
  });

  it('done with short text renders it inline without summary or detail', () => {
    const state = stateFrom([
      { type: 'text', delta: '是的，该接口幂等。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(compact(state)).toMatchSnapshot();
  });

  it('abnormal endings keep status line and skip the summary', () => {
    expect(
      compact(markInterrupted(stateFrom([{ type: 'text', delta: LONG_TEXT }]))),
    ).toMatchSnapshot();
    expect(
      compact(
        stateFrom([
          { type: 'error', message: 'process failed', terminationReason: 'failed' },
        ]),
      ),
    ).toMatchSnapshot();
  });

  it('truncates the detail panel body at DETAIL_MAX (20000 chars + ellipsis)', () => {
    const state = stateFrom([
      { type: 'text', delta: 'x'.repeat(25_000) },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = renderCard(state, { style: 'compact' }) as {
      body: { elements: Array<{ tag?: string; elements?: Array<{ content?: string }> }> };
    };
    const detailPanel = card.body.elements.find((el) => el.tag === 'collapsible_panel');
    const body = detailPanel?.elements?.[0]?.content ?? '';
    expect(body.length).toBe(20_001);
    expect(body.endsWith('…')).toBe(true);
  });

  it('finalReplyText concatenates text blocks only', () => {
    const state = stateFrom([
      { type: 'text', delta: 'part one' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_result', id: 't1', output: 'x', isError: false },
      { type: 'text', delta: 'part two' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(finalReplyText(state)).toBe('part one\npart two');
    expect(SHORT_REPLY_MAX).toBe(100);
  });

  it('streaming style output is unchanged (no style option = current card)', () => {
    const state = stateFrom([
      { type: 'text', delta: 'answer' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    expect(normalizeCard(renderCard(state))).toEqual(
      normalizeCard(renderCard(state, { style: 'streaming' })),
    );
  });
});
