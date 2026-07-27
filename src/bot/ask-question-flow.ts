import type { LarkChannel } from '@larksuite/channel';
import type { AgentRun, AskUserQuestionItem } from '../agent/types';
import { renderAskQuestionAnsweredCard, renderAskQuestionCard } from '../card/ask-question-card';
import { log } from '../core/logger';

export interface AskQuestionAnswerInput {
  toolUseId: string;
  questionIdx: number;
  selectedIndex?: number;
  /** When the card was a multi-select form, the dispatcher forwards
   * `form_value` here; we read `aq_options` (the checker's value list). */
  formValue?: Record<string, unknown> | undefined;
}

/**
 * Orchestrates the lifecycle of one `AskUserQuestion` tool call:
 *   1. claude calls AskUserQuestion → bridge sends Q[0] as an interactive
 *      card.
 *   2. User clicks → dispatcher hands the click to {@link onAnswer}.
 *   3. We map the click → keystrokes → PTY via `run.answerQuestion`.
 *   4. If more questions, send the next card. If last, claude's TUI
 *      finalises the tool_result internally — bridge's polling picks it up
 *      as a normal `tool_result` event next tick.
 *
 * Only one AskUserQuestion can be in flight at a time per run. Starting a
 * new one supersedes any previous pending state.
 */
export class AskQuestionFlow {
  private state:
    | undefined
    | {
        toolUseId: string;
        questions: AskUserQuestionItem[];
        currentIdx: number;
        /** messageId of the card we sent for the *current* question, so we
         * can replace it with a non-interactive answered view after the
         * user submits. */
        currentCardMessageId?: string;
      };

  constructor(
    private readonly opts: {
      run: AgentRun;
      channel: LarkChannel;
      chatId: string;
      signBridgeToken: (action: string) => string;
      sendOpts?: Parameters<LarkChannel['send']>[2];
    },
  ) {}

  /** Are we currently waiting on the user to answer some question? */
  pending(): boolean {
    return this.state !== undefined;
  }

  pendingToolUseId(): string | undefined {
    return this.state?.toolUseId;
  }

  /**
   * Begin a new AskUserQuestion flow. Sends the first question's card.
   */
  async start(toolUseId: string, questions: AskUserQuestionItem[]): Promise<void> {
    this.state = { toolUseId, questions, currentIdx: 0 };
    await this.sendCurrentQuestionCard();
  }

  /** Called by the card dispatcher when a user click arrives. */
  async onAnswer(input: AskQuestionAnswerInput): Promise<void> {
    if (!this.state) {
      log.warn('agent', 'ask-question-answer-no-pending', { toolUseId: input.toolUseId });
      return;
    }
    if (this.state.toolUseId !== input.toolUseId) {
      log.warn('agent', 'ask-question-answer-stale-toolUseId', {
        expected: this.state.toolUseId,
        got: input.toolUseId,
      });
      return;
    }
    if (this.state.currentIdx !== input.questionIdx) {
      log.warn('agent', 'ask-question-answer-stale-idx', {
        expected: this.state.currentIdx,
        got: input.questionIdx,
      });
      return;
    }

    const question = this.state.questions[this.state.currentIdx];
    if (!question) {
      log.warn('agent', 'ask-question-answer-no-question', { idx: this.state.currentIdx });
      return;
    }
    const selections = parseSelections(input, question);
    const isLastQuestion = this.state.currentIdx === this.state.questions.length - 1;

    // Replace the just-answered card with a non-interactive snapshot so
    // double-clicks / late re-tries can't re-submit. Best-effort: if
    // update fails the user might be able to click again, but the
    // dispatcher's nonce-replay guard catches that on the bridge side.
    const answeredMsgId = this.state.currentCardMessageId;
    if (answeredMsgId) {
      const answeredCard = renderAskQuestionAnsweredCard({
        question,
        questionIdx: this.state.currentIdx,
        totalQuestions: this.state.questions.length,
        selectedIndices: selections,
      });
      try {
        await this.opts.channel.updateCard(answeredMsgId, answeredCard);
      } catch (err) {
        log.warn('agent', 'ask-question-freeze-card-failed', {
          messageId: answeredMsgId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!this.opts.run.answerQuestion) {
      log.warn('agent', 'ask-question-no-answer-impl', { toolUseId: input.toolUseId });
      return;
    }
    try {
      await this.opts.run.answerQuestion({
        toolUseId: this.state.toolUseId,
        selections,
        isLastQuestion,
        multiSelect: question.multiSelect === true,
      });
    } catch (err) {
      log.warn('agent', 'ask-question-answer-throw', {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (isLastQuestion) {
      // claude TUI will produce the tool_result asynchronously; bridge's
      // existing JSONL polling will surface it. Nothing more for us to do.
      log.info('agent', 'ask-question-completed', { toolUseId: this.state.toolUseId });
      this.state = undefined;
      return;
    }

    // More questions remain — render the next one.
    this.state.currentIdx += 1;
    await this.sendCurrentQuestionCard();
  }

  /** Called when the run ends or a new AskUserQuestion arrives. Clears state. */
  reset(): void {
    this.state = undefined;
  }

  private async sendCurrentQuestionCard(): Promise<void> {
    if (!this.state) return;
    const question = this.state.questions[this.state.currentIdx];
    if (!question) return;
    const card = renderAskQuestionCard({
      toolUseId: this.state.toolUseId,
      questionIdx: this.state.currentIdx,
      totalQuestions: this.state.questions.length,
      question,
      bridgeToken: this.opts.signBridgeToken('agent_callback'),
    });
    try {
      const sendResult = await this.opts.channel.send(this.opts.chatId, { card }, this.opts.sendOpts);
      this.state.currentCardMessageId = sendResult.messageId;
      log.info('agent', 'ask-question-card-sent', {
        toolUseId: this.state.toolUseId,
        questionIdx: this.state.currentIdx,
        multiSelect: question.multiSelect === true,
        optionCount: question.options.length,
        messageId: sendResult.messageId,
      });
    } catch (err) {
      log.warn('agent', 'ask-question-card-send-failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      // Don't clear state — the user may still see something useful in the
      // card stream, and the run's normal timeout will eventually fire.
    }
  }
}

/**
 * Map a click payload to the 0-based selected option indices for the
 * current question.
 * - Single-select: `selectedIndex` in the bridge payload.
 * - Multi-select: each option is its own `checker` named `aq_opt_<idx>`.
 *   `form_value` carries one entry per checked box; absent / falsy means
 *   unchecked.
 */
function parseSelections(
  input: AskQuestionAnswerInput,
  question: AskUserQuestionItem,
): number[] {
  if (question.multiSelect) {
    const indices: number[] = [];
    const form = input.formValue ?? {};
    for (let i = 0; i < question.options.length; i++) {
      if (isTruthyFormValue(form[`aq_opt_${i}`])) indices.push(i);
    }
    return indices;
  }
  if (typeof input.selectedIndex === 'number') {
    if (input.selectedIndex >= 0 && input.selectedIndex < question.options.length) {
      return [input.selectedIndex];
    }
  }
  return [];
}

function isTruthyFormValue(v: unknown): boolean {
  // Lark's `checker` reports checked state as the boolean true or the
  // string "true". Be defensive about both representations.
  return v === true || (typeof v === 'string' && v.toLowerCase() === 'true');
}
