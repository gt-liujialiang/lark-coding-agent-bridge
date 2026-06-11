import { describe, expect, it } from 'vitest';
import { JsonlTurnTranslator } from '../../../src/agent/claude/jsonl-translate.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function run(entries: unknown[]): AgentEvent[] {
  const t = new JsonlTurnTranslator();
  const out: AgentEvent[] = [];
  for (const e of entries) for (const ev of t.translate(e)) out.push(ev);
  return out;
}

describe('JsonlTurnTranslator', () => {
  it('translates assistant text and tool_use blocks', () => {
    expect(run([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
    ])).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates thinking blocks', () => {
    expect(run([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }] } },
    ])).toEqual([{ type: 'thinking', delta: 'plan' }]);
  });

  it('translates user tool_result, including structured + error', () => {
    expect(run([
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      },
    ])).toEqual([
      { type: 'tool_result', id: 't1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 't2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('synthesizes usage + done on end_turn, summing tokens across assistant entries', () => {
    const events = run([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'first half' }],
          usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 },
        },
      },
      {
        type: 'assistant',
        sessionId: 'sess-xyz',
        message: {
          content: [{ type: 'text', text: 'final' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 7 },
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'first half' },
      { type: 'text', delta: 'final' },
      { type: 'usage', inputTokens: 17, outputTokens: 12, cachedInputTokens: 4 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('ignores unknown / empty / partial entries', () => {
    expect(run([
      null,
      { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }, // no name
      { type: 'system', subtype: 'other' },
    ])).toEqual([]);
  });

  it('reports whether end_turn was seen', () => {
    const t = new JsonlTurnTranslator();
    for (const _ of t.translate({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })) {
      /* drain */
    }
    expect(t.endTurnSeen).toBe(false);
    for (const _ of t.translate({
      type: 'assistant',
      message: { content: [], stop_reason: 'end_turn' },
    })) {
      /* drain */
    }
    expect(t.endTurnSeen).toBe(true);
  });
});
