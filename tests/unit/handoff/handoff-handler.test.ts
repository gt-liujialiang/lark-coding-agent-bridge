import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
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

  type HandoffDeps = Parameters<typeof createHandoffHandler>[0];

  interface MockDeps {
    home: string;
    sessions: { getRaw: Mock; set: Mock };
    sessionCatalog: { upsertActive: Mock };
    agent: { closeSession: Mock };
    channel: { send: Mock };
    activeRuns: { interrupt: Mock };
    resolveOwnerScope: Mock;
    currentPolicyFingerprint: () => string;
    logger: HandoffDeps['logger'];
    _expose: { ownerScope: string; ownerChatId: string };
  }

  function makeDeps(overrides: Partial<{ resolveOwnerScope: Mock }> = {}): MockDeps {
    const ownerScope = 'p2p:oc_owner';
    const ownerChatId = 'oc_owner';
    return {
      home,
      sessions: { getRaw: vi.fn().mockReturnValue({ sessionId: 'old-session' }), set: vi.fn() },
      sessionCatalog: { upsertActive: vi.fn() },
      agent: { closeSession: vi.fn().mockResolvedValue(undefined) },
      channel: { send: vi.fn().mockResolvedValue(undefined) },
      activeRuns: { interrupt: vi.fn() },
      resolveOwnerScope:
        overrides.resolveOwnerScope ??
        vi.fn().mockResolvedValue({ scopeId: ownerScope, chatId: ownerChatId }),
      currentPolicyFingerprint: () => 'fp-1',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      _expose: { ownerScope, ownerChatId },
    };
  }

  it('orchestrates the happy path: interrupt → close old PTY → upsert → set → send card', async () => {
    const cwd = '/Users/test/proj';
    makeJsonl(home, cwd, 'new-session', userLine);
    const deps = makeDeps();
    const handle = createHandoffHandler(deps as unknown as HandoffDeps);
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
    const handle = createHandoffHandler(deps as unknown as HandoffDeps);
    await handle({ op: 'handoff', cwd, sessionId: 'same-session' });
    expect(deps.agent.closeSession).not.toHaveBeenCalled();
  });

  it('returns session-not-found and does NOT mutate state when jsonl missing', async () => {
    const cwd = '/Users/test/proj';
    const deps = makeDeps();
    const handle = createHandoffHandler(deps as unknown as HandoffDeps);
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
    const handle = createHandoffHandler(deps as unknown as HandoffDeps);
    const res = await handle({ op: 'handoff', cwd, sessionId: 's' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('owner-chat-unreachable');
  });
});
