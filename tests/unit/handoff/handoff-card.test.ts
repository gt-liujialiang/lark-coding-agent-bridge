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
    // escapeMd converts _ to \_, which JSON.stringify re-encodes as \\_
    expect(flat).toContain('把 user\\\\_id 字段加到 audit log');
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

  it('formats relative time as "N 分钟前" between 1 min and 1 hour', () => {
    const card = buildHandoffCard({
      cwd: '/x', sessionId: 'a', firstUserMessage: 'foo', lineCount: 1,
      mtimeMs: Date.now() - 90_000, // 1.5 min
    });
    expect(JSON.stringify(card)).toContain('1 分钟前');
  });

  it('formats relative time as "N 小时前" between 1 hour and 1 day', () => {
    const card = buildHandoffCard({
      cwd: '/x', sessionId: 'a', firstUserMessage: 'foo', lineCount: 1,
      mtimeMs: Date.now() - 2 * 60 * 60 * 1000, // 2 hours
    });
    expect(JSON.stringify(card)).toContain('2 小时前');
  });

  it('formats relative time as "N 天前" beyond 1 day', () => {
    const card = buildHandoffCard({
      cwd: '/x', sessionId: 'a', firstUserMessage: 'foo', lineCount: 1,
      mtimeMs: Date.now() - 36 * 60 * 60 * 1000, // 1.5 days
    });
    expect(JSON.stringify(card)).toContain('1 天前');
  });

  it('escapes lark_md special chars in cwd and preview', () => {
    const card = buildHandoffCard({
      cwd: '/path/with`tick',
      sessionId: 'a',
      firstUserMessage: 'foo_bar *baz*',
      lineCount: 1,
      mtimeMs: Date.now(),
    });
    const flat = JSON.stringify(card);
    // escapeCode replaces backticks with single quotes inside code spans
    expect(flat).toContain("/path/with'tick");
    // escapeMd backslash-escapes _ and *; JSON.stringify re-escapes backslashes
    expect(flat).toContain('foo\\\\_bar');
    expect(flat).toContain('\\\\*baz\\\\*');
  });
});
