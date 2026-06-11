import { describe, expect, it } from 'vitest';
import { encodeCwdForClaudeProjects, sessionJsonlPath } from '../../../src/agent/claude/jsonl-path.js';

describe('claudeJsonlPath', () => {
  it('encodes a posix cwd by replacing / with -', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/proj')).toBe('-Users-me-proj');
  });

  it('cleans the cwd before encoding', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/../me/proj//x/')).toBe('-Users-me-proj-x');
  });

  it('builds a JSONL path under ~/.claude/projects', () => {
    const p = sessionJsonlPath({
      home: '/Users/me',
      cwd: '/Users/me/proj',
      sessionId: 'abc-123',
    });
    expect(p).toBe('/Users/me/.claude/projects/-Users-me-proj/abc-123.jsonl');
  });
});
