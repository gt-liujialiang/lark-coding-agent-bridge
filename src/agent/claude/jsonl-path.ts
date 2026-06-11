import { posix, sep } from 'node:path';

/**
 * Mirror of `~/.claude/projects/` layout: each project dir is named after its
 * cwd with every path separator replaced by `-` (cwd is cleaned first to
 * collapse `..` and double-slashes).
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  // Always treat cwd as POSIX — claude writes the same shape on macOS/Linux.
  const cleaned = posix.normalize(cwd.split(sep).join('/')).replace(/\/+$/, '');
  return cleaned.replace(/\//g, '-');
}

export function sessionJsonlPath(input: {
  home: string;
  cwd: string;
  sessionId: string;
}): string {
  const dir = encodeCwdForClaudeProjects(input.cwd);
  return posix.join(input.home, '.claude', 'projects', dir, `${input.sessionId}.jsonl`);
}
