import type { AgentEvent, AskUserQuestionItem } from '../types';

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

interface SystemEntry {
  type?: string;
  subtype?: string;
}

interface JsonlEntry {
  type?: string;
  subtype?: string;
  message?: AssistantMessage | UserMessage;
}

/**
 * Per-turn translator. One instance per `PtySession.runTurn()` so the
 * end-of-turn usage event correctly sums only the turn's assistant entries.
 *
 * Reads JSONL records written to `~/.claude/projects/<encoded>/<id>.jsonl`
 * and emits the bridge's `AgentEvent`.
 *
 * **Turn-end detection:** assistant entries with `stop_reason === "end_turn"`
 * are NOT reliable as turn boundaries by themselves — when claude does
 * Extended Thinking, it splits the response into a *thinking-only* assistant
 * entry (signature-only, no visible text) with `stop_reason: end_turn`,
 * followed by a *text* assistant entry (also `stop_reason: end_turn`) that
 * holds the user-visible reply. If we emit `done` on the first one we lose
 * the second one. The reliable signal is a `system` entry with
 * `subtype: "turn_duration"`, written after all assistant content for the
 * turn — we emit `usage` + `done` then.
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
      if (message?.stop_reason === 'end_turn') {
        this._endTurnSeen = true;
      }
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          yield { type: 'text', delta: block.text };
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          yield { type: 'thinking', delta: block.thinking };
        } else if (block.type === 'tool_use' && block.id && block.name) {
          if (block.name === 'AskUserQuestion') {
            // Special-case claude's built-in AskUserQuestion. Don't emit it
            // as a generic tool_use (the bot can't show a useful panel for a
            // tool that's pending blocking keyboard input); emit a structured
            // event the bot can render as an interactive Lark card.
            const questions = parseAskUserQuestions(block.input);
            if (questions.length > 0) {
              yield {
                type: 'ask_user_question',
                id: block.id,
                questions,
                questionIdx: 0,
              };
            }
            // If the input couldn't be parsed (shouldn't happen with real
            // claude), skip silently — better than emitting half a tool_use.
            continue;
          }
          yield { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
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
      return;
    }
    if (entry.type === 'system') {
      const sys = raw as SystemEntry;
      if (sys.subtype === 'turn_duration' && this._endTurnSeen) {
        yield {
          type: 'usage',
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
          cachedInputTokens: this.cachedInputTokens,
        };
        yield { type: 'done', terminationReason: 'normal' };
      }
    }
  }
}

/**
 * Parse the `input` of an `AskUserQuestion` tool_use into our typed shape.
 * Returns [] if the structure doesn't match.
 */
function parseAskUserQuestions(input: unknown): AskUserQuestionItem[] {
  if (!input || typeof input !== 'object') return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskUserQuestionItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const q = item as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    const question = typeof q.question === 'string' ? q.question : '';
    if (!question) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options: AskUserQuestionItem['options'] = [];
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue;
      const oo = o as { label?: unknown; description?: unknown };
      if (typeof oo.label !== 'string' || !oo.label) continue;
      options.push({
        label: oo.label,
        ...(typeof oo.description === 'string' && oo.description
          ? { description: oo.description }
          : {}),
      });
    }
    if (options.length === 0) continue;
    out.push({
      question,
      ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}
