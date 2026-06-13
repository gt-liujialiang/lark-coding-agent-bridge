import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { normalizeSessionPreview } from './preview';

export interface SessionSummary {
  sessionId: string;
  mtime: number;
  preview: string;
  lineCount: number;
}

/**
 * Like SessionSummary but also carries the real working directory the session
 * was created in (extracted from the jsonl's own metadata rather than the
 * lossy encoded directory name). Used by `/resume all` to surface terminal
 * sessions from arbitrary cwds in a single Lark card.
 */
export interface GlobalSessionSummary extends SessionSummary {
  cwd: string;
  /** ~/foo/bar-style label suitable for display; falls back to full cwd. */
  cwdLabel: string;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function claudeProjectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

/** Return the most recent `limit` jsonl sessions for the given cwd, newest first. */
export async function listRecentSessions(cwd: string, limit = 5): Promise<SessionSummary[]> {
  const dir = claudeProjectDir(cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const jsonls = files.filter((f) => f.endsWith('.jsonl'));
  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      const path = join(dir, f);
      try {
        const st = await stat(path);
        return { file: f, path, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter((x): x is { file: string; path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const sessionId = entry.file.replace(/\.jsonl$/, '');
      const { preview, lineCount } = await summarize(entry.path);
      return { sessionId, mtime: entry.mtime, preview, lineCount };
    }),
  );
}

/**
 * Scan every `~/.claude/projects/<encoded-cwd>/` directory for jsonl files,
 * sort globally by mtime, and return the top `limit`. Each entry carries the
 * real cwd extracted from the jsonl payload (the directory name encoding is
 * lossy and can't always be reversed).
 *
 * Used by `/resume all` to let the user pick up a terminal session that was
 * started in a different cwd than the Lark chat currently has bound.
 */
export async function listAllRecentSessions(limit = 10): Promise<GlobalSessionSummary[]> {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const all: Array<{ path: string; mtime: number; sessionId: string }> = [];
  for (const dir of projectDirs) {
    const projectPath = join(projectsRoot, dir);
    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = join(projectPath, f);
      try {
        const st = await stat(filePath);
        all.push({
          path: filePath,
          mtime: st.mtimeMs,
          sessionId: f.replace(/\.jsonl$/, ''),
        });
      } catch {
        /* ignore unreadable jsonl */
      }
    }
  }

  const sorted = all.sort((a, b) => b.mtime - a.mtime).slice(0, limit);

  return Promise.all(
    sorted.map(async (entry) => {
      const { preview, lineCount, cwd } = await summarizeWithCwd(entry.path);
      return {
        sessionId: entry.sessionId,
        mtime: entry.mtime,
        preview,
        lineCount,
        cwd,
        cwdLabel: shortenCwd(cwd),
      };
    }),
  );
}

function shortenCwd(cwd: string): string {
  if (!cwd) return '(未知目录)';
  const home = homedir();
  return cwd.startsWith(home + '/') || cwd === home
    ? '~' + cwd.slice(home.length)
    : cwd;
}

/**
 * Like `summarize` but also extracts the first `cwd` field encountered. Claude
 * writes its working directory as a top-level field in most entries
 * (attachment, user, etc.); we return the first hit and continue scanning for
 * the preview text. Bails after 200 lines — both fields surface near the top.
 */
async function summarizeWithCwd(path: string): Promise<{ preview: string; lineCount: number; cwd: string }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let cwd = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (obj.type === 'user' && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview = normalizeSessionPreview(text);
          }
        } catch {
          /* malformed line */
        }
      }
      if (!cwd && line.includes('"cwd"')) {
        try {
          const obj = JSON.parse(line) as { cwd?: unknown };
          if (typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
        } catch {
          /* malformed line */
        }
      }
      if (preview && cwd) {
        // Got both fields — still need to count remaining lines for display.
        // Skip the JSON parse fast path; just count.
        for await (const _ of rl) lineCount++;
        break;
      }
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount, cwd };
}

async function summarize(path: string): Promise<{ preview: string; lineCount: number }> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream });
  let preview = '';
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount++;
      if (!preview && line.includes('"type":"user"')) {
        try {
          const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (obj.type === 'user' && obj.message) {
            const text = extractUserText(obj.message.content);
            if (text) preview = normalizeSessionPreview(text);
          }
        } catch {
          /* malformed line */
        }
      }
      // reading the whole file is fine — sessions are usually under 10k lines
      if (lineCount > 20_000) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { preview: preview || '(空会话)', lineCount };
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text.trim();
      }
    }
  }
  return '';
}

/** Format a relative time like "3 小时前", "昨天", "3 天前". */
export function formatRelTime(mtime: number): string {
  const diffMs = Date.now() - mtime;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  return `${mo} 个月前`;
}
