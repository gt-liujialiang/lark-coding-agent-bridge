import type { AskUserQuestionItem } from '../agent/types';

/**
 * Render one question of an `AskUserQuestion` tool call as a Lark
 * schema-2.0 card. The card carries `__bridge_cb` + `bridge_token` so the
 * existing dispatcher recognizes the click as an agent-callback; an extra
 * `__aq` payload field carries the (toolUseId, questionIdx, selection)
 * routing info our handler needs.
 *
 * Layout:
 * - Header chip + question text + per-option description
 * - Single-select: one primary-flavored button per option
 * - Multi-select: a form with a checkbox_group + Submit button
 */
export interface AskQuestionCardInput {
  toolUseId: string;
  questionIdx: number;
  totalQuestions: number;
  question: AskUserQuestionItem;
  /** Signed bridge_token for this run — applied to every callback button. */
  bridgeToken: string;
}

export function renderAskQuestionCard(input: AskQuestionCardInput): object {
  const { question, questionIdx, totalQuestions } = input;
  const isMulti = question.multiSelect === true;
  const progressLabel = totalQuestions > 1 ? ` (${questionIdx + 1}/${totalQuestions})` : '';
  const heading = question.header
    ? `🤔 **${escapeMd(question.header)}**${progressLabel}\n\n${escapeMd(question.question)}`
    : `🤔 ${escapeMd(question.question)}${progressLabel}`;

  const elements: object[] = [{ tag: 'markdown', content: heading }];

  if (isMulti) {
    // Multi-select: form with one `checker` (single checkbox) per option
    // plus a Submit button. Lark's `checker` is a single boolean checkbox,
    // not a checkbox-group; `multi_select_static` works for some
    // dropdown-style forms but doesn't reliably feed selections back
    // through `form_value` with `interactive` cards. Rendering one
    // `checker` per option avoids both issues — on submit, each checked
    // box arrives as `form_value.aq_opt_<idx>: "true"` (or absent).
    const formElements: object[] = question.options.map((opt, idx) => ({
      tag: 'checker',
      name: `aq_opt_${idx}`,
      text: { tag: 'plain_text', content: optionLabel(opt) },
      checked: false,
    }));
    formElements.push({
      tag: 'button',
      name: 'aq_submit',
      text: { tag: 'plain_text', content: '✓ 提交' },
      type: 'primary',
      form_action_type: 'submit',
      behaviors: [
        {
          type: 'callback',
          value: bridgePayload(input, undefined),
        },
      ],
    });
    elements.push({
      tag: 'form',
      name: 'aq_form',
      elements: formElements,
    });
  } else {
    // Single-select: one button per option, each click is a direct selection.
    for (let i = 0; i < question.options.length; i++) {
      const opt = question.options[i]!;
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: optionLabel(opt) },
        type: i === 0 ? 'primary' : 'default',
        behaviors: [
          {
            type: 'callback',
            value: bridgePayload(input, i),
          },
        ],
      });
    }
  }

  return {
    schema: '2.0',
    config: { summary: { content: question.header ?? '需要你选择' } },
    body: { elements },
  };
}

function optionLabel(opt: { label: string; description?: string }): string {
  if (opt.description) return `${opt.label} — ${opt.description}`;
  return opt.label;
}

/**
 * Build the callback value payload. `selectedIndex` is undefined for the
 * multi-select submit button (selections come from `form_value.aq_options`).
 */
function bridgePayload(input: AskQuestionCardInput, selectedIndex: number | undefined): Record<string, unknown> {
  return {
    __bridge_cb: true,
    bridge_token: input.bridgeToken,
    __aq: {
      toolUseId: input.toolUseId,
      questionIdx: input.questionIdx,
      ...(selectedIndex !== undefined ? { selectedIndex } : {}),
    },
  };
}

function escapeMd(s: string): string {
  // Light escape — only avoid the markdown control chars that would
  // visually break the message. Lark's renderer is forgiving.
  return s.replace(/[*_`]/g, (m) => `\\${m}`);
}
