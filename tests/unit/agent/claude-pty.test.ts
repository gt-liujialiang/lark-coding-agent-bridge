import { describe, expect, it } from 'vitest';
import { spawnPty } from '../../../src/agent/claude/pty.js';

describe('spawnPty (node-pty bridge)', () => {
  it('returns a handle that can write input, receive output, and exit', async () => {
    // `cat` echoes whatever we write — perfect for round-tripping a byte.
    const pty = spawnPty({ file: '/bin/cat', args: [], cwd: process.cwd(), env: process.env as Record<string, string> });

    const chunks: string[] = [];
    pty.onData((s) => chunks.push(s));

    const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      pty.onExit(resolve);
    });

    pty.write('hello\n');
    // Give cat a tick to echo
    await new Promise((r) => setTimeout(r, 50));
    pty.kill('SIGTERM');
    const exit = await exited;

    expect(chunks.join('')).toMatch(/hello/);
    expect(typeof exit.exitCode).toBe('number');
  });
});
