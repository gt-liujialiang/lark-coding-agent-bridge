import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pickLatest,
  listCandidates,
  readPreview,
} from '../../../src/agent/claude/jsonl-scan.js';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';

const CWD = '/Users/test/proj';
const ENCODED = encodeCwdForClaudeProjects(CWD);

function setSecondsAgo(path: string, seconds: number): void {
  const t = (Date.now() - seconds * 1000) / 1000;
  utimesSync(path, t, t);
}

describe('jsonl-scan', () => {
  let home: string;
  let dir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lcb-jsonl-'));
    dir = join(home, '.claude', 'projects', ENCODED);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('pickLatest returns the most recent jsonl by mtime', () => {
    const a = join(dir, 'aaa-1111.jsonl');
    const b = join(dir, 'bbb-2222.jsonl');
    writeFileSync(a, '');
    writeFileSync(b, '');
    setSecondsAgo(a, 180);
    setSecondsAgo(b, 60);
    const got = pickLatest({ home, cwd: CWD });
    expect(got?.sessionId).toBe('bbb-2222');
  });

  it('pickLatest returns null on empty/missing dir', () => {
    rmSync(dir, { recursive: true });
    expect(pickLatest({ home, cwd: CWD })).toBeNull();
  });

  it('listCandidates returns N most recent, mtime-desc', () => {
    const a = join(dir, 'aaa-1111.jsonl');
    const b = join(dir, 'bbb-2222.jsonl');
    const c = join(dir, 'ccc-3333.jsonl');
    writeFileSync(a, '');
    writeFileSync(b, '');
    writeFileSync(c, '');
    setSecondsAgo(a, 180);
    setSecondsAgo(b, 60);
    setSecondsAgo(c, 120);
    const got = listCandidates({ home, cwd: CWD, limit: 2 });
    expect(got.map((x) => x.sessionId)).toEqual(['bbb-2222', 'ccc-3333']);
  });

  it('readPreview extracts first user message and line count, truncating to 60 chars', () => {
    const path = join(dir, 'abc-9999.jsonl');
    const longMsg = '把 user_id 字段加到 audit log 里面，方便后续审计追踪每个请求的来源';
    const lines = [
      JSON.stringify({ type: 'summary', text: 'preamble' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: longMsg } }),
      JSON.stringify({ type: 'assistant', message: { content: 'ok' } }),
      'this is malformed json{',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'second' } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n');
    const preview = readPreview(path);
    expect(preview.lineCount).toBe(5);
    expect(preview.firstUserMessage.length).toBeLessThanOrEqual(60);
    expect(preview.firstUserMessage.startsWith('把 user_id 字段')).toBe(true);
  });

  it('readPreview returns empty preview when no user message exists', () => {
    const path = join(dir, 'def-0000.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'assistant', message: { content: 'hi' } }) + '\n');
    const preview = readPreview(path);
    expect(preview.firstUserMessage).toBe('');
    expect(preview.lineCount).toBe(1);
  });
});
