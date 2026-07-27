import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlReader } from '../../../src/agent/claude/jsonl-reader.js';

describe('JsonlReader', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('returns no entries when the file does not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const r = new JsonlReader(join(dir, 'missing.jsonl'));
    const { entries, lineCount } = await r.readNew();
    expect(entries).toEqual([]);
    expect(lineCount).toBe(0);
  });

  it('reads only entries past the cursor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    await writeFile(path,
      `${JSON.stringify({ a: 1 })}\n` +
      `${JSON.stringify({ a: 2 })}\n`,
    );
    const r = new JsonlReader(path);
    const first = await r.readNew();
    expect(first.entries).toEqual([{ a: 1 }, { a: 2 }]);
    expect(first.lineCount).toBe(2);

    await appendFile(path, `${JSON.stringify({ a: 3 })}\n`);
    const second = await r.readNew();
    expect(second.entries).toEqual([{ a: 3 }]);
    expect(second.lineCount).toBe(3);
  });

  it('skips blank lines and tolerates a trailing partial line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    await writeFile(path,
      `${JSON.stringify({ ok: true })}\n` +
      `\n` +
      `{"partial":`,
    );
    const r = new JsonlReader(path);
    const result = await r.readNew();
    expect(result.entries).toEqual([{ ok: true }]);
    // Partial trailing line is not counted as complete — cursor stays before it
    // so a follow-up readNew picks it up when the line finishes.
    expect(result.lineCount).toBe(1);
  });

  it('allows seeking the cursor forward', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-reader-'));
    dirs.push(dir);
    const path = join(dir, 'session.jsonl');
    await writeFile(path,
      `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n`,
    );
    const r = new JsonlReader(path);
    r.setCursor(1);
    const { entries } = await r.readNew();
    expect(entries).toEqual([{ a: 2 }]);
  });
});
