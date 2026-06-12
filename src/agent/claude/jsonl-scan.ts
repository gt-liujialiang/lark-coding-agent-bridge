import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeCwdForClaudeProjects } from './jsonl-path.js';

export interface JsonlCandidate {
  sessionId: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

export interface JsonlPreview {
  firstUserMessage: string;
  lineCount: number;
  mtimeMs: number;
}

export interface ScanArgs {
  home: string;
  cwd: string;
}

const PREVIEW_MAX_CHARS = 60;

function scanDir(args: ScanArgs): JsonlCandidate[] {
  const dir = join(args.home, '.claude', 'projects', encodeCwdForClaudeProjects(args.cwd));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: JsonlCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (!s.isFile()) continue;
    entries.push({
      sessionId: name.slice(0, -'.jsonl'.length),
      path: full,
      mtimeMs: s.mtimeMs,
      bytes: s.size,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

export function pickLatest(args: ScanArgs): JsonlCandidate | null {
  const all = scanDir(args);
  return all[0] ?? null;
}

export function listCandidates(args: ScanArgs & { limit: number }): JsonlCandidate[] {
  return scanDir(args).slice(0, args.limit);
}

export function readPreview(path: string): JsonlPreview {
  let buf: string;
  try {
    buf = readFileSync(path, 'utf8');
  } catch {
    return { firstUserMessage: '', lineCount: 0, mtimeMs: 0 };
  }
  const mtimeMs = (() => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const lines = buf.split('\n').filter((l) => l.length > 0);
  let firstUser = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (obj.type !== 'user') continue;
      const role = obj.message?.role;
      if (role !== 'user') continue;
      const content = obj.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .map((c) =>
                  typeof c === 'object' && c && 'text' in c
                    ? String((c as { text?: unknown }).text ?? '')
                    : '',
                )
                .join(' ')
            : '';
      if (!text) continue;
      firstUser =
        text.length > PREVIEW_MAX_CHARS ? text.slice(0, PREVIEW_MAX_CHARS - 1) + '…' : text;
      break;
    } catch {
      continue;
    }
  }
  return { firstUserMessage: firstUser, lineCount: lines.length, mtimeMs };
}
