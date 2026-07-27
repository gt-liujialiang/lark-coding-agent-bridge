import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ptyMock = vi.hoisted(() => ({
  spawnPty: vi.fn(),
}));

vi.mock('../../../src/agent/claude/pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/claude/pty')>();
  return { ...actual, spawnPty: ptyMock.spawnPty };
});

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
  prefixBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudePtyAdapter } from '../../../src/agent/claude/pty-adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import type { PtyHandle } from '../../../src/agent/claude/pty';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

function fakePtyHandle(): PtyHandle & { triggerExit: (code: number) => void } {
  const exitListeners: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  return {
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((listener: (e: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener);
    }),
    kill: vi.fn(),
    triggerExit: (code: number) => exitListeners.forEach((l) => l({ exitCode: code })),
  };
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
  ptyMock.spawnPty.mockReset();
});

describe('ClaudePtyAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt after setBotIdentity', async () => {
    // spawnPty is synchronous inside spawnSession. Capture the args and handle via the mock.
    let capturedArgs: string[] | undefined;
    let capturedHandle: ReturnType<typeof fakePtyHandle> | undefined;
    ptyMock.spawnPty.mockImplementation((opts: { args: string[] }) => {
      capturedArgs = opts.args;
      capturedHandle = fakePtyHandle();
      return capturedHandle;
    });

    const adapter = new ClaudePtyAdapter({ readinessQuietMs: 0 });
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    // Start iterating events — this triggers pool.acquire → spawnSession → spawnPty.
    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    const collectPromise = (async () => {
      const out = [];
      for await (const e of run.events) {
        out.push(e);
        if (e.type === 'error' || e.type === 'done') break;
      }
      return out;
    })();

    // Give the pool.acquire chain a moment to run, then trigger PTY exit.
    await new Promise((r) => setTimeout(r, 50));
    capturedHandle?.triggerExit(0);
    await collectPromise;

    expect(capturedArgs).toBeDefined();
    const flagIndex = capturedArgs!.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(capturedArgs![flagIndex + 1]).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    let capturedArgs: string[] | undefined;
    let capturedHandle: ReturnType<typeof fakePtyHandle> | undefined;
    ptyMock.spawnPty.mockImplementation((opts: { args: string[] }) => {
      capturedArgs = opts.args;
      capturedHandle = fakePtyHandle();
      return capturedHandle;
    });

    const adapter = new ClaudePtyAdapter({ readinessQuietMs: 0 });

    const run = adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    const collectPromise = (async () => {
      const out = [];
      for await (const e of run.events) {
        out.push(e);
        if (e.type === 'error' || e.type === 'done') break;
      }
      return out;
    })();

    await new Promise((r) => setTimeout(r, 50));
    capturedHandle?.triggerExit(0);
    await collectPromise;

    expect(capturedArgs).toBeDefined();
    const flagIndex = capturedArgs!.indexOf('--append-system-prompt');
    expect(capturedArgs![flagIndex + 1]).toBe(buildBridgeSystemPrompt(undefined));
  });
});

describe('CodexAdapter system prompt wiring', () => {
  function codexAdapter(): CodexAdapter {
    return new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
    });
  }

  it('prefixes stdin with the identity-aware bridge system prompt after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    const stdin = await readAll(child.stdin);
    expect(stdin).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
