import { describe, expect, it } from 'vitest';
import { renderAskQuestionCard } from '../../../src/card/ask-question-card.js';

describe('renderAskQuestionCard', () => {
  it('renders a single-select question as one button per option', () => {
    const card = renderAskQuestionCard({
      toolUseId: 'toolu_x',
      questionIdx: 0,
      totalQuestions: 1,
      bridgeToken: 'SIGNED',
      question: {
        question: 'Pick a color',
        header: 'Color',
        options: [
          { label: 'Red', description: 'bold' },
          { label: 'Blue' },
        ],
      },
    }) as { schema: string; body: { elements: { tag: string; text?: { content: string }; type?: string; behaviors?: { type: string; value: Record<string, unknown> }[] }[] } };

    expect(card.schema).toBe('2.0');
    const els = card.body.elements;
    expect(els[0]?.tag).toBe('markdown');
    // Two option buttons (one per option), no form.
    const buttons = els.filter((e) => e.tag === 'button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.text?.content).toBe('Red — bold');
    expect(buttons[1]?.text?.content).toBe('Blue');
    expect(buttons[0]?.type).toBe('primary');
    expect(buttons[1]?.type).toBe('default');
    const v0 = buttons[0]?.behaviors?.[0]?.value as { __aq?: { selectedIndex?: number; toolUseId?: string; questionIdx?: number }; bridge_token?: string; __bridge_cb?: boolean };
    expect(v0.__bridge_cb).toBe(true);
    expect(v0.bridge_token).toBe('SIGNED');
    expect(v0.__aq?.toolUseId).toBe('toolu_x');
    expect(v0.__aq?.questionIdx).toBe(0);
    expect(v0.__aq?.selectedIndex).toBe(0);
    expect(((buttons[1]?.behaviors?.[0]?.value) as { __aq: { selectedIndex: number } }).__aq.selectedIndex).toBe(1);
  });

  it('renders a multi-select question as a form with multi_select_static + submit', () => {
    const card = renderAskQuestionCard({
      toolUseId: 'toolu_y',
      questionIdx: 1,
      totalQuestions: 2,
      bridgeToken: 'TOK',
      question: {
        question: 'Pick fruits',
        multiSelect: true,
        options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }],
      },
    }) as { body: { elements: ({ tag: 'markdown'; content: string } | { tag: 'form'; name: string; elements: object[] })[] } };

    const els = card.body.elements;
    expect((els[0] as { content: string }).content).toMatch(/Pick fruits/);
    expect((els[0] as { content: string }).content).toMatch(/\(2\/2\)/);
    const form = els.find((e) => e.tag === 'form') as { elements: ({ tag: 'multi_select_static'; name: string; options: { value: string; text: { content: string } }[] } | { tag: 'button'; behaviors: { value: Record<string, unknown> }[] })[] };
    expect(form).toBeTruthy();
    const ms = form.elements.find((e) => e.tag === 'multi_select_static') as { name: string; options: { value: string; text: { content: string } }[] };
    expect(ms.name).toBe('aq_options');
    expect(ms.options.map((o) => o.value)).toEqual(['0', '1', '2']);
    expect(ms.options.map((o) => o.text.content)).toEqual(['Apple', 'Banana', 'Cherry']);
    const submit = form.elements.find((e) => e.tag === 'button') as unknown as { behaviors: { value: { __aq: { questionIdx: number; toolUseId: string; selectedIndex?: number } } }[] };
    expect(submit.behaviors[0]?.value.__aq.toolUseId).toBe('toolu_y');
    expect(submit.behaviors[0]?.value.__aq.questionIdx).toBe(1);
    // No `selectedIndex` on the submit button — selections come from form_value.
    expect(submit.behaviors[0]?.value.__aq.selectedIndex).toBeUndefined();
  });

  it('omits the (n/m) progress indicator when there is only one question', () => {
    const card = renderAskQuestionCard({
      toolUseId: 'toolu_z',
      questionIdx: 0,
      totalQuestions: 1,
      bridgeToken: 'T',
      question: { question: 'OK?', options: [{ label: 'yes' }, { label: 'no' }] },
    }) as { body: { elements: { content: string }[] } };
    expect(card.body.elements[0]?.content).not.toMatch(/\(\d+\/\d+\)/);
  });
});
