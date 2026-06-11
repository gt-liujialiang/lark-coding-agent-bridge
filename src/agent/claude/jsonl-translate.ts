import type { AgentEvent } from '../types';

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AssistantMessage {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

interface UserMessage {
  content?: ContentBlock[];
}

interface JsonlEntry {
  type?: string;
  message?: AssistantMessage | UserMessage;
}

/**
 * Per-turn translator. One instance per `PtySession.runTurn()` so the
 * end-of-turn usage event correctly sums only the turn's assistant entries.
 *
 * Reads JSONL records written to `~/.claude/projects/<encoded>/<id>.jsonl`
 * and emits the bridge's `AgentEvent`. When an assistant entry carries
 * `stop_reason: "end_turn"`, the translator synthesizes a `usage` event
 * (summed across the turn) followed by a `done` event.
 */
export class JsonlTurnTranslator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private _endTurnSeen = false;

  get endTurnSeen(): boolean {
    return this._endTurnSeen;
  }

  *translate(raw: unknown): Generator<AgentEvent> {
    if (!raw || typeof raw !== 'object') return;
    const entry = raw as JsonlEntry;
    if (entry.type === 'assistant') {
      const message = entry.message as AssistantMessage | undefined;
      if (message?.usage) {
        const u = message.usage;
        this.inputTokens +=
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        this.outputTokens += u.output_tokens ?? 0;
        this.cachedInputTokens += u.cache_read_input_tokens ?? 0;
      }
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          yield { type: 'text', delta: block.text };
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          yield { type: 'thinking', delta: block.thinking };
        } else if (block.type === 'tool_use' && block.id && block.name) {
          yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
      }
      if (message?.stop_reason === 'end_turn' && !this._endTurnSeen) {
        this._endTurnSeen = true;
        yield {
          type: 'usage',
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          cachedInputTokens: this.cachedInputTokens,
        };
        yield { type: 'done', terminationReason: 'normal' };
      }
      return;
    }
    if (entry.type === 'user') {
      const message = entry.message as UserMessage | undefined;
      for (const block of message?.content ?? []) {
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
    }
  }
}
