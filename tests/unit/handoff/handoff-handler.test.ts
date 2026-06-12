import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwdForClaudeProjects } from '../../../src/agent/claude/jsonl-path.js';
import { createHandoffHandler } from '../../../src/runtime/handoff-handler.js';

function makeJsonl(home: string, cwd: string, sessionId: string, content: string): string {
  const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, content);
  return path;
}

const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n';

describe('handoff handler', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lcb-handoff-'));
  });

  function makeDeps(overrides: Partial<Parameters<typeof createHandoffHandler>[0]> = {}) {
    const ownerScope = 'p2p:oc_owner';
    const ownerChatId = 'oc_owner';
    const sessions = {
      getRaw: vi.fn().mockReturnValue({ sessionId: 'old-session' }),
      set: vi.fn(),
    };
    const sessionCatalog = {
      upsertActive: vi.fn(),
    };
    const agent = {
      closeSession: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const activeRuns = {
      interrupt: vi.fn(),
    };
    const resolveOwnerScope = vi
      .fn()
      .mockResolvedValue({ scopeId: ownerScope, chatId: ownerChatId });
    return {
      home,
      sessions,
      sessionCatalog,
      agent,
      channel,
      activeRuns,
      resolveOwnerScope,
      currentPolicyFingerprint: () => 'fp-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
      _expose: { ownerScope, ownerChatId },
    };
  }

  it('orchestrates the happy path: interrupt → close old PTY → upsert → set → send card', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 'new-session', userLine);
    const deps = makeDeps();
    const handle = createHandoffHandler(deps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 'new-session' });

    expect(res.ok).toBe(true);
    const callOrder = [
      deps.activeRuns.interrupt.mock.invocationCallOrder[0]!,
      deps.agent.closeSession.mock.invocationCallOrder[0]!,
      deps.sessionCatalog.upsertActive.mock.invocationCallOrder[0]!,
      deps.sessions.set.mock.invocationCallOrder[0]!,
      deps.channel.send.mock.invocationCallOrder[0]!,
    ];
    expect(callOrder).toEqual([...callOrder].sort((a, b) => a - b));
    expect(deps.agent.closeSession).toHaveBeenCalledWith('old-session');
    expect(deps.sessions.set).toHaveBeenCalledWith(
      deps._expose.ownerScope,
      'new-session',
      cwd,
    );
    expect(deps.channel.send).toHaveBeenCalledWith(
      deps._expose.ownerChatId,
      expect.objectContaining({ card: expect.any(Object) }),
    );
  });

  it('does NOT close prev PTY when sessionId matches active session', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 'same-session', userLine);
    const deps = makeDeps();
    deps.sessions.getRaw.mockReturnValue({ sessionId: 'same-session' });
    const handle = createHandoffHandler(deps);
    await handle({ op: 'handoff', cwd, sessionId: 'same-session' });
    expect(deps.agent.closeSession).not.toHaveBeenCalled();
  });

  it('returns session-not-found and does NOT mutate state when jsonl missing', async () => {
    const cwd = '/Users/test/proj';
    const deps = makeDeps();
    const handle = createHandoffHandler(deps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 'ghost' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('session-not-found');
    expect(deps.activeRuns.interrupt).not.toHaveBeenCalled();
    expect(deps.sessions.set).not.toHaveBeenCalled();
    expect(deps.channel.send).not.toHaveBeenCalled();
  });

  it('returns owner-chat-unreachable when resolveOwnerScope returns null', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 's', userLine);
    const deps = makeDeps({ resolveOwnerScope: vi.fn().mockResolvedValue(null) });
    const handle = createHandoffHandler(deps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 's' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('owner-chat-unreachable');
  });
});
