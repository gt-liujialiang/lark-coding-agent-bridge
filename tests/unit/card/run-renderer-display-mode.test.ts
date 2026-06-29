import { describe, expect, it } from 'vitest';
import { renderCard, type ToolDisplayMode } from '../../../src/card/run-renderer.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import type { AgentEvent } from '../../../src/agent/types.js';

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

interface RenderedCard {
  body?: { elements?: ElementShape[] };
}
interface ElementShape {
  tag?: string;
  content?: string;
  text_size?: string;
  elements?: ElementShape[];
}

function render(state: RunState, mode: ToolDisplayMode): RenderedCard {
  return renderCard(state, { toolDisplay: mode }) as RenderedCard;
}

function findFirstMarkdown(elements: ElementShape[] | undefined, predicate: (s: string) => boolean): string | undefined {
  if (!elements) return undefined;
  for (const e of elements) {
    if (e.tag === 'markdown' && typeof e.content === 'string' && predicate(e.content)) {
      return e.content;
    }
  }
  return undefined;
}

function countCollapsiblePanels(elements: ElementShape[] | undefined): number {
  if (!elements) return 0;
  return elements.filter((e) => e.tag === 'collapsible_panel').length;
}

const TOOL_BURST: AgentEvent[] = [
  { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
  { type: 'tool_result', id: 't1', output: '/repo', isError: false },
  { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/src/foo.ts' } },
  { type: 'tool_result', id: 't2', output: 'export const x = 1;', isError: false },
  { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/src/foo.ts' } },
  { type: 'tool_result', id: 't3', output: 'ok', isError: false },
];

describe('renderCard tool display modes', () => {
  it("full mode renders collapsible tool panels (existing behavior)", () => {
    const card = render(stateFrom([...TOOL_BURST, { type: 'done', terminationReason: 'normal' }]), 'full');
    // With 3 tools and finalized, the renderer emits one collapsed summary panel.
    expect(countCollapsiblePanels(card.body?.elements)).toBeGreaterThanOrEqual(1);
  });

  it('compact mode emits a single header-only markdown block, no collapsible panels', () => {
    const card = render(stateFrom([...TOOL_BURST, { type: 'done', terminationReason: 'normal' }]), 'compact');
    expect(countCollapsiblePanels(card.body?.elements)).toBe(0);
    const summary = findFirstMarkdown(card.body?.elements, (s) => s.includes('Bash') && s.includes('Read') && s.includes('Edit'));
    expect(summary).toBeDefined();
    // It should not contain the full bash output.
    expect(summary).not.toContain('/repo\n');
    // Should be a list of header lines.
    expect(summary).toMatch(/- .*Bash/);
    expect(summary).toMatch(/- .*Read/);
    expect(summary).toMatch(/- .*Edit/);
  });

  it('compact mode shows the running tool but still without a body panel', () => {
    const card = render(
      stateFrom([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test:unit' } },
      ]),
      'compact',
    );
    expect(countCollapsiblePanels(card.body?.elements)).toBe(0);
    const line = findFirstMarkdown(card.body?.elements, (s) => s.includes('Bash'));
    expect(line).toContain('pnpm test:unit');
  });

  it('hide mode emits no tool elements at all but keeps text and footer', () => {
    const card = render(
      stateFrom([
        { type: 'text', delta: 'starting' },
        ...TOOL_BURST,
        { type: 'text', delta: 'done analyzing' },
        { type: 'done', terminationReason: 'normal' },
      ]),
      'hide',
    );
    expect(countCollapsiblePanels(card.body?.elements)).toBe(0);
    const allText = (card.body?.elements ?? [])
      .filter((e) => e.tag === 'markdown')
      .map((e) => e.content ?? '')
      .join('\n');
    expect(allText).toContain('starting');
    expect(allText).toContain('done analyzing');
    // No tool headers should be present.
    expect(allText).not.toMatch(/\bBash\b/);
    expect(allText).not.toMatch(/\bRead\b/);
    expect(allText).not.toMatch(/\bEdit\b/);
  });

  it('hide mode while running still shows the stop button and footer', () => {
    const card = render(
      stateFrom([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
      ]),
      'hide',
    );
    const tags = (card.body?.elements ?? []).map((e) => e.tag);
    expect(tags).toContain('button');
  });

  it('omitting toolDisplay falls back to full', () => {
    const stateDone = stateFrom([...TOOL_BURST, { type: 'done', terminationReason: 'normal' }]);
    const defaultCard = renderCard(stateDone) as RenderedCard;
    const fullCard = render(stateDone, 'full');
    expect(countCollapsiblePanels(defaultCard.body?.elements)).toBe(
      countCollapsiblePanels(fullCard.body?.elements),
    );
  });
});
