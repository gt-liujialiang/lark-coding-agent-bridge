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

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
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
