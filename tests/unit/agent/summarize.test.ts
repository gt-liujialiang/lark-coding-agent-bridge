import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { fallbackSummary, summarizeReply } from '../../../src/agent/summarize.js';

interface FakeChildScript {
  stdout?: string;
  exitCode?: number;
  /** 永不退出（用来触发超时）。 */
  hang?: boolean;
  /** 触发 spawn error 事件。 */
  spawnError?: string;
  /** 在 stdin 流上触发 error 事件（模拟 EPIPE）。 */
  stdinError?: string;
}

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killed: boolean;
  killSignal?: string;
  kill: (sig?: string) => void;
}

function fakeSpawn(script: FakeChildScript) {
  const calls: { command: string; args: string[]; stdin: string }[] = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: readonly string[] = []) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = (sig?: string) => {
      child.killed = true;
      child.killSignal = sig;
    };
    let stdinBuf = '';
    child.stdin.on('data', (d) => {
      stdinBuf += String(d);
    });
    const call = { command, args: [...args], stdin: '' };
    calls.push(call);
    children.push(child);
    setImmediate(() => {
      call.stdin = stdinBuf;
      if (script.spawnError) {
        child.emit('error', new Error(script.spawnError));
        return;
      }
      if (script.stdinError) {
        child.stdin.emit('error', new Error(script.stdinError));
      }
      if (script.hang) return;
      if (script.stdout) child.stdout.write(script.stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', script.exitCode ?? 0);
    });
    return child;
  };
  return { spawn: spawn as never, calls, children };
}

const LONG_REPLY = `扣减失败的根因是 sync_status 未回写。\n后续段落。${'x'.repeat(200)}`;

describe('summarizeReply', () => {
  it('returns trimmed model output and passes model/prompt/stdin', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: '  根因是 sync_status 未回写。\n' });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('根因是 sync_status 未回写。');
    expect(calls[0]?.command).toBe('claude');
    expect(calls[0]?.args).toContain('--model');
    expect(calls[0]?.args).toContain('haiku');
    expect(calls[0]?.stdin).toContain('sync_status');
  });

  it('falls back to first line on non-zero exit', async () => {
    const { spawn } = fakeSpawn({ stdout: 'partial', exitCode: 1 });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });

  it('falls back on empty output', async () => {
    const { spawn } = fakeSpawn({ stdout: '   \n' });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });

  it('falls back on spawn error', async () => {
    const { spawn } = fakeSpawn({ spawnError: 'ENOENT' });
    const out = await summarizeReply(LONG_REPLY, { spawn });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });

  it('kills the child and falls back on timeout', async () => {
    const { spawn, children } = fakeSpawn({ hang: true });
    const out = await summarizeReply(LONG_REPLY, { spawn, timeoutMs: 30 });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
    expect(children[0]?.killed).toBe(true);
    expect(children[0]?.killSignal).toBe('SIGKILL');
  });

  it('survives a stdin stream error (EPIPE) and falls back', async () => {
    const { spawn } = fakeSpawn({ stdinError: 'EPIPE', hang: true });
    const out = await summarizeReply(LONG_REPLY, { spawn, timeoutMs: 1000 });
    expect(out).toBe('扣减失败的根因是 sync_status 未回写。');
  });
});

describe('fallbackSummary', () => {
  it('takes the first non-empty line, capped at 80 chars', () => {
    expect(fallbackSummary('\n\n  第一行结论  \n第二行')).toBe('第一行结论');
    const long = 'a'.repeat(120);
    expect(fallbackSummary(long)).toBe(`${'a'.repeat(80)}…`);
  });
});
