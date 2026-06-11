import { open } from 'node:fs/promises';

export interface JsonlReadResult {
  entries: Record<string, unknown>[];
  lineCount: number;
}

/**
 * Tails a JSONL file by line index. Each call returns the entries appended
 * since the last call. A trailing partial line (no terminating "\n") is held
 * back until the writer finishes it — the cursor only advances past complete
 * lines, so polling is idempotent.
 */
export class JsonlReader {
  private cursor = 0;
  private leftover = '';

  constructor(private readonly path: string, private readonly maxLineBytes = 16 * 1024 * 1024) {}

  setCursor(line: number): void {
    this.cursor = Math.max(0, Math.floor(line));
    this.leftover = '';
  }

  async readNew(): Promise<JsonlReadResult> {
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], lineCount: this.cursor };
      }
      throw err;
    }
    try {
      const stat = await handle.stat();
      // 1 MB read window per pass; loop until we've consumed the file.
      const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(64 * 1024, stat.size)));
      const lines: string[] = [];
      let offset = 0;
      let buffered = this.leftover;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        buffered += buf.subarray(0, bytesRead).toString('utf8');
        let nl = buffered.indexOf('\n');
        while (nl !== -1) {
          lines.push(buffered.slice(0, nl));
          buffered = buffered.slice(nl + 1);
          if (buffered.length > this.maxLineBytes) {
            throw new Error(`JsonlReader: line exceeds ${this.maxLineBytes} bytes`);
          }
          nl = buffered.indexOf('\n');
        }
      }
      this.leftover = buffered;

      const entries: Record<string, unknown>[] = [];
      let lineCount = 0;
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) continue; // blank lines are transparent to the cursor
        lineCount += 1;
        if (lineCount <= this.cursor) continue;
        try {
          entries.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Malformed line — skip, matches seed behavior.
        }
      }
      this.cursor = lineCount;
      return { entries, lineCount };
    } finally {
      await handle.close();
    }
  }
}
