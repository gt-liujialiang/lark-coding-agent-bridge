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

  it('synthesizes usage + done only when system.turn_duration arrives (after all assistant entries)', () => {
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
        message: {
          content: [{ type: 'text', text: 'final' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 7 },
        },
      },
      { type: 'system', subtype: 'turn_duration', durationMs: 1234 },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'first half' },
      { type: 'text', delta: 'final' },
      { type: 'usage', inputTokens: 17, outputTokens: 12, cachedInputTokens: 4 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('survives the Extended-Thinking case: thinking-only end_turn entry followed by text entry', () => {
    // Repro of the real-claude scenario where the response is split into two
    // assistant entries both carrying stop_reason="end_turn" — the first one
    // is signature-only thinking with no text, the second one holds the
    // actual reply. We must NOT emit `done` after the first entry; we wait
    // for the system.turn_duration marker.
    const events = run([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'the real reply' }], stop_reason: 'end_turn' } },
      { type: 'system', subtype: 'turn_duration', durationMs: 1 },
    ]);
    expect(events).toEqual([
      { type: 'text', delta: 'the real reply' },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      { type: 'done', terminationReason: 'normal' },
    ]);
  });

  it('does not emit done from turn_duration when no assistant end_turn was seen', () => {
    // turn_duration without a preceding end_turn should be a no-op
    // (defensive — shouldn't happen in practice).
    expect(run([
      { type: 'system', subtype: 'turn_duration', durationMs: 100 },
    ])).toEqual([]);
  });

  it('ignores unknown / empty / partial entries', () => {
    expect(run([
      null,
      { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } }, // no name
      { type: 'system', subtype: 'other' },
    ])).toEqual([]);
  });

  it('translates AskUserQuestion tool_use into a structured ask_user_question event', () => {
    expect(run([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_aq',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Pick a color',
                    header: 'Color',
                    multiSelect: false,
                    options: [
                      { label: 'Red', description: 'bold' },
                      { label: 'Blue' },
                    ],
                  },
                  {
                    question: 'Pick fruits',
                    multiSelect: true,
                    options: [
                      { label: 'Apple' },
                      { label: 'Banana' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ])).toEqual([
      {
        type: 'ask_user_question',
        id: 'toolu_aq',
        questionIdx: 0,
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            options: [
              { label: 'Red', description: 'bold' },
              { label: 'Blue' },
            ],
          },
          {
            question: 'Pick fruits',
            multiSelect: true,
            options: [{ label: 'Apple' }, { label: 'Banana' }],
          },
        ],
      },
    ]);
  });

  it('does not emit ask_user_question when input is malformed', () => {
    expect(run([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: { questions: 'bad' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'AskUserQuestion', input: { questions: [{ options: [] }] } }] } },
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
