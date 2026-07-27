import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

/**
 * One question inside an `AskUserQuestion` tool call. Mirrors the schema the
 * claude TUI's built-in `AskUserQuestion` tool accepts.
 */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

export interface ToolInFlight {
  id: string;
  name: string;
  /** Human-readable one-liner like "Bash · pnpm test:unit" or "Edit · src/foo.ts". */
  label: string;
  /** Wall-clock (ms epoch) when the tool_use was first seen in JSONL. */
  startedAt: number;
}

export interface TodoItem {
  content: string;
  /** Verb form ("Writing tests"); falls back to `content` if absent. */
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoSnapshot {
  total: number;
  completed: number;
  /** Index of the first `in_progress` item, or null if none active. */
  inProgressIdx: number | null;
  items: TodoItem[];
}

export interface TurnSnapshot {
  /** ms epoch when this turn started. */
  turnStartedAt: number;
  /** ms epoch when JSONL last produced new entries. */
  lastEntryAt: number;
  /** Total JSONL entries observed in this turn (for diagnostics). */
  entriesSeen: number;
  /** Tools whose `tool_use` was seen but no matching `tool_result` yet. */
  inFlightTools: ToolInFlight[];
  /** Most recent fully-completed tool (got its `tool_result`), or null. */
  lastCompletedTool: ToolInFlight | null;
  /** Tail of recent assistant text, last ~200 chars. */
  lastTextTail: string;
  /** Latest todo list from TaskCreate/TaskUpdate/TodoWrite; null if claude hasn't used the tool. */
  todos: TodoSnapshot | null;
  /** Running token totals for this turn. */
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
}

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      /**
       * Emitted by PtySession when the turn has been idle (no new JSONL entries)
       * for a configured threshold. The turn is *not* terminated — consumers can
       * surface this to the user (e.g. a Lark check-in card) and decide whether
       * to wait or interrupt.
       */
      type: 'idle_checkpoint';
      /** ms since the last JSONL entry. */
      idleMs: number;
      /** 1-based: 1st checkpoint at default threshold, 2nd at backoff, etc. */
      checkpointNumber: number;
      snapshot: TurnSnapshot;
    }
  /**
   * Special-cased `tool_use` for claude's built-in `AskUserQuestion` tool.
   * Translators emit this *instead of* a regular `tool_use` so consumers
   * (bridge bot layer) can present an interactive flow and route the user's
   * choice back via `AgentRun.answerQuestion`.
   *
   * - `id` is the original `tool_use_id` — needed when answering.
   * - `questions` carries all questions from the single tool call.
   * - `questionIdx` is the question to present next (0-based). Consumers
   *   should render one question at a time; the translator emits this event
   *   only once per tool_use, but the bot can render Q[0], wait for the
   *   answer, then render Q[1], etc., by calling `answerQuestion` with
   *   `isLastQuestion` correctly.
   */
  | {
      type: 'ask_user_question';
      id: string;
      questions: AskUserQuestionItem[];
      questionIdx: number;
    }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
  /**
   * Deliver an answer to a pending `AskUserQuestion`. Optional — adapters
   * that don't surface `ask_user_question` events can omit it.
   *
   * - `toolUseId`: the `id` of the originating `ask_user_question` event.
   * - `selections`: option indices (0-based, in the order claude listed
   *   them) the user picked for this question. Single-select gets one;
   *   multi-select can pass multiple.
   * - `isLastQuestion`: true when this is the final question in the
   *   tool call. The adapter uses this to commit / submit the whole batch
   *   (e.g. send Enter at the very end).
   */
  answerQuestion?(input: {
    toolUseId: string;
    selections: number[];
    isLastQuestion: boolean;
    multiSelect: boolean;
  }): Promise<void>;
  /**
   * Tell the underlying session (if any) that the user has acknowledged a
   * pending `idle_checkpoint` and wants to keep waiting. Restarts the
   * checkpoint backoff from the first threshold. Optional — adapters that
   * don't emit `idle_checkpoint` events may omit it.
   */
  resetIdleCheckpoint?(): Promise<void>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
  /**
   * Bridge hook called when a Lark session's persisted state is cleared
   * (`/new`, `/cd`, `/reset`, `/resume` to a different id). Adapters that
   * own per-session resources (e.g., long-lived PTYs) should free them.
   * `sessionId` is the previously-active claude session id.
   */
  closeSession?(sessionId: string): Promise<void>;
}
