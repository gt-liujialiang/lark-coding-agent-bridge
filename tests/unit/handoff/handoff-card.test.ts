import { describe, expect, it } from 'vitest';
import { buildHandoffCard } from '../../../src/card/handoff-card.js';

describe('handoff card', () => {
  it('builds a CardKit 2.0 card with all key fields rendered', () => {
    const card = buildHandoffCard({
      cwd: '/Users/test/proj',
      sessionId: 'abc12345-6789-4def-0000-111122223333',
      firstUserMessage: '把 user_id 字段加到 audit log',
      lineCount: 47,
      mtimeMs: Date.now() - 60 * 1000,
    });
    expect(card.schema).toBe('2.0');
    const flat = JSON.stringify(card);
    expect(flat).toContain('/Users/test/proj');
    expect(flat).toContain('abc12345-6789-4def-0000-111122223333');
    expect(flat).toContain('把 user_id 字段加到 audit log');
    expect(flat).toContain('47');
    expect(flat).toContain('/resume');
  });

  it('handles empty preview gracefully', () => {
    const card = buildHandoffCard({
      cwd: '/x',
      sessionId: 'a',
      firstUserMessage: '',
      lineCount: 0,
      mtimeMs: Date.now(),
    });
    expect(JSON.stringify(card)).not.toContain('undefined');
  });

  it('formats relative time as "刚刚" for < 60s', () => {
    const card = buildHandoffCard({
      cwd: '/x',
      sessionId: 'a',
      firstUserMessage: 'foo',
      lineCount: 1,
      mtimeMs: Date.now() - 5_000,
    });
    expect(JSON.stringify(card)).toContain('刚刚');
  });
});
