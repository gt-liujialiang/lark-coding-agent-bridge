import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce(reduce, initialState);
}

function firstTopLevelText(card: object): string {
  const body = (card as { body?: { elements?: Array<Record<string, unknown>> } }).body;
  const first = body?.elements?.[0];
  return first && first.tag === 'markdown' ? String(first.content) : '';
}

const DONE = { type: 'done', terminationReason: 'normal' } as const;

describe('conclusion-focus rendering', () => {
  const investigation = stateFrom([
    { type: 'thinking', delta: '先按班级 ID 查' },
    { type: 'text', delta: '先跑这条 SQL 拿到订单...\n\n关键差异：is_merge_pay=1\n\n' },
    { type: 'text', delta: '## ✅ 结论\n这批订单是微信合单支付，收款走成都星荟。' },
    DONE,
  ]);

  it('splits conclusion to top and folds process when enabled + marker present', () => {
    const card = renderCard(investigation, { conclusionFocus: true });
    expect(firstTopLevelText(card)).toContain('结论');
    expect(firstTopLevelText(card)).toContain('成都星荟');
    const all = JSON.stringify(card);
    expect(all).toContain('排查过程与证据');
    expect(all).toContain('先跑这条 SQL');
  });

  it('falls back to normal rendering when marker absent', () => {
    const noMarker = stateFrom([
      { type: 'text', delta: '直接给你答案：改一行即可。' },
      DONE,
    ]);
    const focused = renderCard(noMarker, { conclusionFocus: true });
    const normal = renderCard(noMarker, {});
    expect(JSON.stringify(focused)).toBe(JSON.stringify(normal));
  });

  it('does not split while running (terminal !== done)', () => {
    const running = stateFrom([
      { type: 'text', delta: '## 结论\n初步结论' },
    ]);
    expect(JSON.stringify(renderCard(running, { conclusionFocus: true }))).not.toContain(
      '排查过程与证据',
    );
  });

  it('does nothing when toggle off (identical to default render)', () => {
    const off = renderCard(investigation, { conclusionFocus: false });
    const normal = renderCard(investigation, {});
    expect(JSON.stringify(off)).toBe(JSON.stringify(normal));
  });

  it('uses the last marker when multiple present', () => {
    const multi = stateFrom([
      { type: 'text', delta: '## 结论\n这是中间的假结论小节\n\n## ✅ 结论\n真正的最终结论' },
      DONE,
    ]);
    const card = renderCard(multi, { conclusionFocus: true });
    expect(firstTopLevelText(card)).toContain('真正的最终结论');
    expect(firstTopLevelText(card)).not.toContain('假结论');
  });
});
