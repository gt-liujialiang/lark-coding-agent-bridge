import { describe, expect, it } from 'vitest';
import { formatLedgerReportCard } from '../../../src/commands/report-format';
import type { LedgerSummary } from '../../../src/observability/ledger';

const summary: LedgerSummary = {
  total: 3,
  byChatKind: { p2p: 1, group: 2, topic: 0 },
  totalInputTokens: 12340,
  totalOutputTokens: 860,
  totalCostUsd: 0.1234,
  votes: { up: 1, down: 1 },
  byUser: [
    { openId: 'ou_a', name: 'Alice', count: 2, inputTokens: 12000, outputTokens: 800, costUsd: 0.1, up: 1, down: 0 },
    { openId: 'ou_b', count: 1, inputTokens: 340, outputTokens: 60, costUsd: 0.0234, up: 0, down: 1 },
  ],
};

describe('formatLedgerReportCard', () => {
  it('builds a card with a per-user table showing usernames', () => {
    const card = formatLedgerReportCard(summary) as {
      body: { elements: Array<{ tag: string; columns?: Array<{ display_name: string }>; rows?: Array<Record<string, string>> }> };
    };
    const table = card.body.elements.find((e) => e.tag === 'table');
    expect(table).toBeDefined();
    expect(table?.columns?.map((c) => c.display_name)).toEqual(['用户', '交互', '输入/输出', '费用', '反馈']);
    expect(table?.rows?.[0]?.user).toBe('Alice');
    // Unnamed user falls back to short id.
    expect(table?.rows?.[1]?.user).toBe('ou_b'.slice(-6));
    expect(table?.rows?.[0]?.vote).toBe('👍1 👎0');
  });

  it('includes a summary header with totals and feedback', () => {
    const json = JSON.stringify(formatLedgerReportCard(summary));
    expect(json).toContain('交互 3 次');
    expect(json).toContain('私聊 1');
    expect(json).toContain('群聊 2');
    expect(json).toContain('$0.12');
    expect(json).toContain('👍 1 · 👎 1');
  });

  it('prefers resolved display names from the name map over stored name/id', () => {
    const names = new Map([
      ['ou_a', '爱丽丝'],
      ['ou_b', '鲍勃'],
    ]);
    const table = (formatLedgerReportCard(summary, names) as {
      body: { elements: Array<{ tag: string; rows?: Array<Record<string, string>> }> };
    }).body.elements.find((e) => e.tag === 'table');
    expect(table?.rows?.[0]?.user).toBe('爱丽丝');
    expect(table?.rows?.[1]?.user).toBe('鲍勃');
  });

  it('handles an empty ledger', () => {
    const empty: LedgerSummary = {
      total: 0,
      byChatKind: { p2p: 0, group: 0, topic: 0 },
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      votes: { up: 0, down: 0 },
      byUser: [],
    };
    expect(JSON.stringify(formatLedgerReportCard(empty))).toContain('暂无');
  });
});
