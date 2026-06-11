import { describe, expect, it } from 'vitest';
import { encodeCwdForClaudeProjects, sessionJsonlPath } from '../../../src/agent/claude/jsonl-path.js';

describe('claudeJsonlPath', () => {
  it('encodes a posix cwd by replacing / with -', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/proj')).toBe('-Users-me-proj');
  });

  it('cleans the cwd before encoding', () => {
    expect(encodeCwdForClaudeProjects('/Users/me/../me/proj//x/')).toBe('-Users-me-proj-x');
  });

  it('also replaces ".", "_", and other non-alphanumerics with "-"', () => {
    // Matches claude 2.1.150+ project-dir naming.
    expect(encodeCwdForClaudeProjects('/Users/me/.lark_workspaces/proj.A')).toBe(
      '-Users-me--lark-workspaces-proj-A',
    );
    expect(encodeCwdForClaudeProjects('/var/folders/y4/m2xtk_n7pz/T/x')).toBe(
      '-var-folders-y4-m2xtk-n7pz-T-x',
    );
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
