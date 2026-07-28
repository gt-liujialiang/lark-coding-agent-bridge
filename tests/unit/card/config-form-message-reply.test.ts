import { describe, expect, it } from 'vitest';
import { configFormCard } from '../../../src/card/config-card.js';

type FormCard = {
  body: { elements: Array<{ tag: string; name?: string; elements?: unknown[] }> };
};
type Select = {
  name: string;
  initial_option?: string;
  options: Array<{ value: string; text: { content: string } }>;
};

function messageReplySelect(card: object): Select {
  const c = card as FormCard;
  const form = c.body.elements.find((e) => e.tag === 'form') as { elements: Select[] };
  const sel = form.elements.find((e) => (e as Select).name === 'message_reply');
  if (!sel) throw new Error('message_reply select not found');
  return sel as Select;
}

const base = {
  messageReply: 'markdown',
  toolCallDisplay: 'compact',
  toolCallDisplayInGroups: 'inherit',
  requireMentionInGroup: false,
  maxConcurrentRuns: 10,
  runIdleTimeoutMinutes: 0,
  allowedUsers: [],
  allowedChats: [],
  allowedGroups: [],
  admins: [],
  knownChats: new Map(),
  larkCliIdentity: 'app-only',
  replyInThreadInGroup: false,
  claudeDriver: 'pty',
} as Parameters<typeof configFormCard>[0];

describe('configFormCard message_reply picker exposes card', () => {
  it('offers card (交互卡片) as a selectable option', () => {
    const sel = messageReplySelect(configFormCard(base));
    expect(sel.options.map((o) => o.value)).toContain('card');
    const cardOpt = sel.options.find((o) => o.value === 'card');
    expect(cardOpt?.text.content).toContain('交互卡片');
  });

  it('preselects card when the current mode is card (no downgrade to markdown)', () => {
    const sel = messageReplySelect(configFormCard({ ...base, messageReply: 'card' }));
    expect(sel.initial_option).toBe('card');
  });

  it('still preselects the stored mode for markdown / text', () => {
    expect(
      messageReplySelect(configFormCard({ ...base, messageReply: 'markdown' })).initial_option,
    ).toBe('markdown');
    expect(
      messageReplySelect(configFormCard({ ...base, messageReply: 'text' })).initial_option,
    ).toBe('text');
  });
});
