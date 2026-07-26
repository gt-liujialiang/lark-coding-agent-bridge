import type { LedgerSummary } from '../observability/ledger';

/** Compact tokens: 1234 → "1.2k", <1000 stays as-is. */
function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

const TOP_N = 20;

/** Render the usage ledger summary as a CardKit 2.0 card with a per-user
 * table (username-first) plus a summary header. Sent by `/report`.
 * `names` resolves open_id → display name (contact lookup); falls back to the
 * ledger's stored name, then a short id. */
export function formatLedgerReportCard(s: LedgerSummary, names?: Map<string, string>): object {
  if (s.total === 0) {
    return {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: '📒 台账暂无记录。' }] },
    };
  }

  const header = [
    '📒 **使用台账汇总**',
    '',
    `- 交互 ${s.total} 次（私聊 ${s.byChatKind.p2p} · 群聊 ${s.byChatKind.group}${
      s.byChatKind.topic ? ` · 话题 ${s.byChatKind.topic}` : ''
    }）`,
    `- Tokens：输入 ${fmtTokens(s.totalInputTokens)} · 输出 ${fmtTokens(s.totalOutputTokens)}`,
    `- 费用：$${s.totalCostUsd.toFixed(2)}`,
    `- 反馈：👍 ${s.votes.up} · 👎 ${s.votes.down}`,
  ].join('\n');

  const rows = s.byUser.slice(0, TOP_N).map((u) => ({
    user: names?.get(u.openId) ?? u.name ?? u.openId.slice(-6),
    count: String(u.count),
    tokens: `${fmtTokens(u.inputTokens)}/${fmtTokens(u.outputTokens)}`,
    cost: `$${u.costUsd.toFixed(2)}`,
    vote: `👍${u.up} 👎${u.down}`,
  }));
  const omitted = s.byUser.length - rows.length;

  const elements: object[] = [
    { tag: 'markdown', content: header },
    {
      tag: 'table',
      row_height: 'low',
      header_style: { text_align: 'left', text_size: 'normal', bold: true },
      columns: [
        { name: 'user', display_name: '用户', data_type: 'text', width: 'auto' },
        { name: 'count', display_name: '交互', data_type: 'text', width: 'auto' },
        { name: 'tokens', display_name: '输入/输出', data_type: 'text', width: 'auto' },
        { name: 'cost', display_name: '费用', data_type: 'text', width: 'auto' },
        { name: 'vote', display_name: '反馈', data_type: 'text', width: 'auto' },
      ],
      rows,
    },
  ];
  if (omitted > 0) {
    elements.push({ tag: 'markdown', content: `_…另有 ${omitted} 人未在表内_`, text_size: 'notation' });
  }

  return { schema: '2.0', body: { elements } };
}
