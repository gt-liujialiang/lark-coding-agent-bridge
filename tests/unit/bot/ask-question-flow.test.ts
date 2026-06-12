import { describe, expect, it, vi } from 'vitest';
import { AskQuestionFlow } from '../../../src/bot/ask-question-flow.js';
import type { AgentRun, AskUserQuestionItem } from '../../../src/agent/types.js';

function makeFlow(overrides?: { answerQuestion?: ReturnType<typeof vi.fn> }) {
  const channelSend = vi.fn().mockResolvedValue(undefined);
  const answerQuestion = overrides?.answerQuestion ?? vi.fn().mockResolvedValue(undefined);
  const run = {
    runId: 'r1',
    events: (async function* () {})(),
    async stop() {},
    async waitForExit() { return true; },
    answerQuestion,
  } satisfies AgentRun;
  const flow = new AskQuestionFlow({
    run,
    channel: { send: channelSend } as unknown as ConstructorParameters<typeof AskQuestionFlow>[0]['channel'],
    chatId: 'oc_test',
    signBridgeToken: () => 'TOK',
  });
  return { flow, channelSend, answerQuestion };
}

const Q_SINGLE: AskUserQuestionItem = {
  question: 'pick',
  options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
};
const Q_MULTI: AskUserQuestionItem = {
  question: 'pick many',
  multiSelect: true,
  options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
};

describe('AskQuestionFlow', () => {
  it('start() sends the first question card and registers as pending', async () => {
    const { flow, channelSend } = makeFlow();
    await flow.start('tu1', [Q_SINGLE]);
    expect(flow.pending()).toBe(true);
    expect(flow.pendingToolUseId()).toBe('tu1');
    expect(channelSend).toHaveBeenCalledTimes(1);
    const [chatId, msg] = channelSend.mock.calls[0]!;
    expect(chatId).toBe('oc_test');
    expect((msg as { card?: { schema?: string } }).card?.schema).toBe('2.0');
  });

  it('single-select answer routes selections + clears state on last question', async () => {
    const { flow, answerQuestion } = makeFlow();
    await flow.start('tu1', [Q_SINGLE]);
    await flow.onAnswer({ toolUseId: 'tu1', questionIdx: 0, selectedIndex: 1 });
    expect(answerQuestion).toHaveBeenCalledWith({
      toolUseId: 'tu1',
      selections: [1],
      isLastQuestion: true,
      multiSelect: false,
    });
    expect(flow.pending()).toBe(false);
  });

  it('multi-question single-select walks the questions in order', async () => {
    const { flow, channelSend, answerQuestion } = makeFlow();
    await flow.start('tu2', [Q_SINGLE, Q_SINGLE]);

    // Q[0] click
    await flow.onAnswer({ toolUseId: 'tu2', questionIdx: 0, selectedIndex: 2 });
    expect(answerQuestion).toHaveBeenLastCalledWith({
      toolUseId: 'tu2',
      selections: [2],
      isLastQuestion: false,
      multiSelect: false,
    });
    expect(channelSend).toHaveBeenCalledTimes(2); // initial + next-question card
    expect(flow.pending()).toBe(true);

    // Q[1] click
    await flow.onAnswer({ toolUseId: 'tu2', questionIdx: 1, selectedIndex: 0 });
    expect(answerQuestion).toHaveBeenLastCalledWith({
      toolUseId: 'tu2',
      selections: [0],
      isLastQuestion: true,
      multiSelect: false,
    });
    expect(flow.pending()).toBe(false);
    expect(channelSend).toHaveBeenCalledTimes(2); // no new card after final
  });

  it('multi-select collects checked aq_opt_* fields from form_value', async () => {
    const { flow, answerQuestion } = makeFlow();
    await flow.start('tu3', [Q_MULTI]);
    await flow.onAnswer({
      toolUseId: 'tu3',
      questionIdx: 0,
      formValue: { aq_opt_0: true, aq_opt_1: false, aq_opt_2: true },
    });
    expect(answerQuestion).toHaveBeenCalledWith({
      toolUseId: 'tu3',
      selections: [0, 2],
      isLastQuestion: true,
      multiSelect: true,
    });
  });

  it('multi-select tolerates "true"/"false" string form values', async () => {
    const { flow, answerQuestion } = makeFlow();
    await flow.start('tu4', [Q_MULTI]);
    await flow.onAnswer({
      toolUseId: 'tu4',
      questionIdx: 0,
      formValue: { aq_opt_0: 'false', aq_opt_1: 'true', aq_opt_2: 'true' },
    });
    expect(answerQuestion).toHaveBeenCalledWith({
      toolUseId: 'tu4',
      selections: [1, 2],
      isLastQuestion: true,
      multiSelect: true,
    });
  });

  it('drops stale answers (wrong toolUseId or wrong questionIdx)', async () => {
    const { flow, answerQuestion } = makeFlow();
    await flow.start('tu5', [Q_SINGLE, Q_SINGLE]);

    await flow.onAnswer({ toolUseId: 'WRONG', questionIdx: 0, selectedIndex: 0 });
    expect(answerQuestion).not.toHaveBeenCalled();

    await flow.onAnswer({ toolUseId: 'tu5', questionIdx: 1, selectedIndex: 0 }); // expected idx 0
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it('reset() clears pending state', async () => {
    const { flow } = makeFlow();
    await flow.start('tu6', [Q_SINGLE]);
    flow.reset();
    expect(flow.pending()).toBe(false);
  });
});
