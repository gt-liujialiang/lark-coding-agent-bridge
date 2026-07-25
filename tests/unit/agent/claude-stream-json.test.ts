import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter.js';
import { createStreamJsonTranslator, translateEvent } from '../../../src/agent/claude/stream-json.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('Claude stream-json translator', () => {
  it('translates system init metadata', () => {
    expect([
      ...translateEvent({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/repo',
        model: 'sonnet',
      }),
    ]).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/repo', model: 'sonnet' },
    ]);
    expect([...translateEvent({ type: 'system', subtype: 'init', session_id: 'sess-1' })][0]).not.toHaveProperty('threadId');
  });

  it('translates assistant text, thinking, and tool_use blocks in order', () => {
    expect([
      ...translateEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'checking' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ]).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'thinking', delta: 'checking' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('translates user tool_result blocks including structured output and errors', () => {
    expect([
      ...translateEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              content: [{ type: 'text', text: 'bad' }],
              is_error: true,
            },
          ],
        },
      }),
    ]).toEqual([
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      {
        type: 'tool_result',
        id: 'tool-2',
        output: JSON.stringify([{ type: 'text', text: 'bad' }]),
        isError: true,
      },
    ]);
  });

  it('translates result usage before done', () => {
    expect([
      ...translateEvent({
        type: 'result',
        session_id: 'sess-2',
        usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 },
        total_cost_usd: 0.1234,
      }),
    ]).toEqual([
      { type: 'usage', inputTokens: 12, outputTokens: 34, cachedInputTokens: 5, costUsd: 0.1234 },
      { type: 'done', sessionId: 'sess-2', terminationReason: 'normal' },
    ]);
    expect([...translateEvent({ type: 'result', session_id: 'sess-2' })][0]).not.toHaveProperty('threadId');
  });

  it('ignores unknown, empty, and incomplete raw events', () => {
    expect([...translateEvent(null)]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' }] } })]).toEqual([]);
    expect([...translateEvent({ type: 'system', subtype: 'other' })]).toEqual([]);
  });
});

describe('Claude stream-json stateful translator (partial messages)', () => {
  const streamEvent = (event: object, parentToolUseId: string | null = null): object => ({
    type: 'stream_event',
    event,
    session_id: 'sess-1',
    parent_tool_use_id: parentToolUseId,
  });
  const textDelta = (text: string): object =>
    streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });
  const thinkingDelta = (thinking: string): object =>
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    });

  it('emits token-level text deltas and skips the duplicate assistant text block', () => {
    const translate = createStreamJsonTranslator();
    const out: AgentEvent[] = [
      ...translate(streamEvent({ type: 'message_start', message: { role: 'assistant' } })),
      ...translate(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })),
      ...translate(textDelta('hello ')),
      ...translate(textDelta('world')),
      // CLI repeats the completed block as a full assistant line — must be deduped.
      ...translate({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }),
      ...translate(streamEvent({ type: 'content_block_stop', index: 1 })),
    ];
    expect(out).toEqual([
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
    ]);
  });

  it('emits thinking deltas, dedupes them, and still passes tool_use blocks through', () => {
    const translate = createStreamJsonTranslator();
    const out: AgentEvent[] = [
      ...translate(streamEvent({ type: 'message_start', message: { role: 'assistant' } })),
      ...translate(thinkingDelta('pondering')),
      ...translate({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      }),
    ];
    expect(out).toEqual([
      { type: 'thinking', delta: 'pondering' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ]);
  });

  it('resets dedup state on message_start so the next message streams again', () => {
    const translate = createStreamJsonTranslator();
    [...translate(streamEvent({ type: 'message_start', message: {} }))];
    [...translate(textDelta('first'))];
    [...translate({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'first' }] },
    })];
    // New API message: without a fresh reset the next full assistant line
    // would be wrongly skipped if no deltas arrived for it.
    [...translate(streamEvent({ type: 'message_start', message: {} }))];
    const out = [
      ...translate({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'second (no deltas)' }] },
      }),
    ];
    expect(out).toEqual([{ type: 'text', delta: 'second (no deltas)' }]);
  });

  it('falls back to whole-message translation when no deltas were seen', () => {
    const translate = createStreamJsonTranslator();
    const out = [
      ...translate({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'whole block' }] },
      }),
    ];
    expect(out).toEqual([{ type: 'text', delta: 'whole block' }]);
  });

  it('ignores subagent stream events (parent_tool_use_id set)', () => {
    const translate = createStreamJsonTranslator();
    const out = [
      ...translate(
        streamEvent(
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inner' } },
          'tool-parent-1',
        ),
      ),
    ];
    expect(out).toEqual([]);
  });

  it('ignores non-text deltas like signature_delta and input_json_delta', () => {
    const translate = createStreamJsonTranslator();
    const out = [
      ...translate(
        streamEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'abc' },
        }),
      ),
      ...translate(
        streamEvent({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"comm' },
        }),
      ),
    ];
    expect(out).toEqual([]);
  });
});

describe('Claude stream-json live usage accumulation', () => {
  const msgStart = (input: number, output = 0, parent: string | null = null): object => ({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_start', message: { usage: { input_tokens: input, output_tokens: output } } },
  });
  const msgDelta = (output: number, input: number, parent: string | null = null): object => ({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_delta', usage: { input_tokens: input, output_tokens: output } },
  });
  const usageOf = (events: object[]): Array<{ inputTokens?: number; outputTokens?: number }> =>
    events.filter((e) => (e as { type?: string }).type === 'usage') as never;

  it('emits a running usage total on message_start and message_delta', () => {
    const translate = createStreamJsonTranslator();
    const out = [
      ...translate(msgStart(13606)),
      ...translate(msgDelta(168, 13606)),
    ];
    expect(usageOf(out)).toEqual([
      { type: 'usage', inputTokens: 13606, outputTokens: 0 },
      { type: 'usage', inputTokens: 13606, outputTokens: 168 },
    ]);
  });

  it('accumulates input and output across multiple turns', () => {
    const translate = createStreamJsonTranslator();
    [...translate(msgStart(13606))];
    [...translate(msgDelta(168, 13606))];
    // Turn 2 begins — prior turn's tokens must be committed, not lost.
    const t2start = usageOf([...translate(msgStart(2))]);
    const t2delta = usageOf([...translate(msgDelta(42, 2))]);
    expect(t2start).toEqual([{ type: 'usage', inputTokens: 13608, outputTokens: 168 }]);
    expect(t2delta).toEqual([{ type: 'usage', inputTokens: 13608, outputTokens: 210 }]);
  });

  it('ignores subagent stream-event usage (parent_tool_use_id set)', () => {
    const translate = createStreamJsonTranslator();
    const out = [
      ...translate(msgStart(500, 0, 'tool-parent')),
      ...translate(msgDelta(99, 500, 'tool-parent')),
    ];
    expect(usageOf(out)).toEqual([]);
  });

  it('still forwards the authoritative result usage with cost at the end', () => {
    const translate = createStreamJsonTranslator();
    [...translate(msgStart(13606))];
    [...translate(msgDelta(168, 13606))];
    const out = usageOf([
      ...translate({
        type: 'result',
        session_id: 's',
        usage: { input_tokens: 13608, output_tokens: 210 },
        total_cost_usd: 0.276,
      }),
    ]);
    expect(out).toEqual([
      { type: 'usage', inputTokens: 13608, outputTokens: 210, cachedInputTokens: undefined, costUsd: 0.276 },
    ]);
  });
});

describe('Claude stream-json reader behavior', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('skips non-JSON stdout lines and reports non-zero stderr detail without redacting visible paths', async () => {
    const stderr = 'fatal stderr at /Users/example/work/repo/file.ts';
    const binary = await createFakeBinary([
      'not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'kept' }] } }),
    ], 7, stderr);
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-reader',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([
      { type: 'text', delta: 'kept' },
      {
        type: 'error',
        message: `claude exited with code 7: ${stderr}`,
        terminationReason: 'failed',
      },
    ]);
  });

  it('dedupes partial-message deltas against the repeated assistant line across lines', async () => {
    const binary = await createFakeBinary([
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { role: 'assistant' } },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
        parent_tool_use_id: null,
      }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
    ], 0, '');
    cleanup = binary.cleanup;

    const run = new ClaudeAdapter({ binary: binary.path }).run({
      runId: 'run-dedup',
      prompt: 'hi',
      cwd: tmpdir(),
    });
    const events = await collect(run.events);

    expect(events).toEqual([{ type: 'text', delta: 'hi' }]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function createFakeBinary(lines: string[], exitCode: number, stderr: string): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stream-json-test-'));
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      `const lines = ${JSON.stringify(lines)};`,
      'for (const line of lines) console.log(line);',
      `process.stderr.write(${JSON.stringify(stderr)});`,
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return {
    path,
    cleanup: async () => {
      const { rm } = await import('node:fs/promises');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
