export interface HandoffCardInput {
  cwd: string;
  sessionId: string;
  firstUserMessage: string;
  lineCount: number;
  mtimeMs: number;
}

export interface HandoffCard {
  schema: '2.0';
  config: { wide_screen_mode: boolean };
  header: { title: { tag: 'plain_text'; content: string } };
  body: { elements: unknown[] };
}

function relTime(mtimeMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}

export function buildHandoffCard(input: HandoffCardInput): HandoffCard {
  const previewLine = input.firstUserMessage || '(无预览)';
  const time = relTime(input.mtimeMs);

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔗 已接管终端 Claude 会话' },
    },
    body: {
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**项目**\n\`${input.cwd}\``,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**Session ID**\n\`${input.sessionId}\``,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**主题**\n${previewLine}`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**对话**\n${input.lineCount} 条 · ${time}`,
          },
        },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [
            { tag: 'plain_text', content: '直接发消息继续 · 回 /resume 可切回旧会话' },
          ],
        },
      ],
    },
  };
}
