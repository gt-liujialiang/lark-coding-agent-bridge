import { posix, sep } from 'node:path';

/**
 * Mirror of `~/.claude/projects/` layout: claude (as of 2.1.150) names each
 * project dir after its cwd with every non-alphanumeric character replaced by
 * `-`. That collapses `/`, `.`, `_`, and other punctuation uniformly, so
 * `/Users/me/.lark_workspaces/proj.A` → `-Users-me--lark-workspaces-proj-A`.
 *
 * Older claude versions only replaced `/`; if claude changes the rule again,
 * this is the single place to update.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  // Always treat cwd as POSIX — claude writes the same shape on macOS/Linux.
  const cleaned = posix.normalize(cwd.split(sep).join('/')).replace(/\/+$/, '');
  return cleaned.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function sessionJsonlPath(input: {
  home: string;
  cwd: string;
  sessionId: string;
}): string {
  const dir = encodeCwdForClaudeProjects(input.cwd);
  return posix.join(input.home, '.claude', 'projects', dir, `${input.sessionId}.jsonl`);
}
