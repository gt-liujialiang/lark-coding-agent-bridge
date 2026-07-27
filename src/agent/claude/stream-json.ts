import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
  parent_tool_use_id?: string | null;
  event?: {
    type?: string;
    message?: { usage?: { input_tokens?: number; output_tokens?: number } };
    usage?: { input_tokens?: number; output_tokens?: number };
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
}

/**
 * Stateful translator for one claude run, wrapping `translateEvent`.
 *
 * With `--include-partial-messages` the CLI emits token-level `stream_event`
 * deltas AND, after each content block completes, an `assistant` line that
 * repeats the same content. We forward text/thinking deltas as they arrive
 * and skip the repeated blocks on the assistant line; tool_use blocks still
 * come from the assistant line (their input is not streamed as text).
 *
 * When no deltas were seen for the current message (older CLI, flag dropped),
 * assistant lines translate whole — same behavior as before.
 */
export function createStreamJsonTranslator(): (raw: unknown) => Generator<AgentEvent> {
  let streamedText = false;
  let streamedThinking = false;
  // Live token accounting for real-time display. Each assistant turn reports
  // its own input (at message_start) and cumulative output (at message_delta);
  // the run total is the sum across turns. We commit the finished turn's
  // figures when the next turn's message_start arrives.
  let committedInput = 0;
  let committedOutput = 0;
  let curInput = 0;
  let curOutput = 0;
  return function* translate(raw: unknown): Generator<AgentEvent> {
    if (!raw || typeof raw !== 'object') return;
    const evt = raw as ClaudeRawEvent;

    if (evt.type === 'stream_event') {
      // Subagent (Task tool) internals keep today's message-level behavior,
      // and their tokens are already folded into the final result total.
      if (evt.parent_tool_use_id) return;
      const inner = evt.event;
      if (inner?.type === 'message_start') {
        streamedText = false;
        streamedThinking = false;
        // Commit the turn that just ended, then open the new one.
        committedInput += curInput;
        committedOutput += curOutput;
        curInput = inner.message?.usage?.input_tokens ?? 0;
        curOutput = inner.message?.usage?.output_tokens ?? 0;
        yield* emitLiveUsage(committedInput + curInput, committedOutput + curOutput);
        return;
      }
      if (inner?.type === 'message_delta') {
        if (inner.usage?.input_tokens !== undefined) curInput = inner.usage.input_tokens;
        if (inner.usage?.output_tokens !== undefined) curOutput = inner.usage.output_tokens;
        yield* emitLiveUsage(committedInput + curInput, committedOutput + curOutput);
        return;
      }
      if (inner?.type !== 'content_block_delta') return;
      const delta = inner.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        streamedText = true;
        yield { type: 'text', delta: delta.text };
      } else if (delta?.type === 'thinking_delta' && delta.thinking) {
        streamedThinking = true;
        yield { type: 'thinking', delta: delta.thinking };
      }
      return;
    }

    if (
      evt.type === 'assistant' &&
      evt.message?.content &&
      !evt.parent_tool_use_id &&
      (streamedText || streamedThinking)
    ) {
      const content = evt.message.content.filter(
        (block) =>
          !(block.type === 'text' && streamedText) &&
          !(block.type === 'thinking' && streamedThinking),
      );
      yield* translateEvent({ ...evt, message: { ...evt.message, content } });
      return;
    }

    yield* translateEvent(raw);
  };
}

/** Live usage carries no cost (only the final result does) and is skipped
 * entirely until at least one token is counted, so the footer never flashes
 * a meaningless "输入 0 · 输出 0". */
function* emitLiveUsage(inputTokens: number, outputTokens: number): Generator<AgentEvent> {
  if (inputTokens === 0 && outputTokens === 0) return;
  yield { type: 'usage', inputTokens, outputTokens };
}

export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as ClaudeRawEvent;

  if (evt.type === 'system' && evt.subtype === 'init') {
    yield {
      type: 'system',
      sessionId: evt.session_id,
      cwd: evt.cwd,
      model: evt.model,
    };
    return;
  }

  if (evt.type === 'assistant' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        yield { type: 'text', delta: block.text };
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        yield { type: 'thinking', delta: block.thinking };
      } else if (block.type === 'tool_use' && block.id && block.name) {
        yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message?.content) {
    for (const block of evt.message.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        const output =
          typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        yield {
          type: 'tool_result',
          id: block.tool_use_id,
          output,
          isError: block.is_error === true,
        };
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.usage) {
      yield {
        type: 'usage',
        inputTokens: evt.usage.input_tokens,
        outputTokens: evt.usage.output_tokens,
        cachedInputTokens: evt.usage.cache_read_input_tokens,
        costUsd: evt.total_cost_usd,
      };
    }
    yield { type: 'done', sessionId: evt.session_id, terminationReason: 'normal' };
  }
}
