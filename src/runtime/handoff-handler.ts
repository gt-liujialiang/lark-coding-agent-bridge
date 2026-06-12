import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { encodeCwdForClaudeProjects } from '../agent/claude/jsonl-path.js';
import { readPreview } from '../agent/claude/jsonl-scan.js';
import { buildHandoffCard } from '../card/handoff-card.js';
import type {
  HandoffRequest,
  ControlResponse,
} from './control-protocol.js';

export interface HandoffDeps {
  home: string;
  sessions: {
    getRaw(scope: string): { sessionId?: string } | undefined;
    set(scope: string, sessionId: string, cwd: string): void;
  };
  sessionCatalog: {
    upsertActive(entry: {
      scopeId: string;
      agentId: 'claude';
      cwdRealpath: string;
      policyFingerprint: string;
      sessionId: string;
    }): void;
  };
  agent: {
    closeSession?: (sessionId: string) => Promise<void>;
  };
  channel: {
    send(chatId: string, payload: { card: unknown }): Promise<void>;
  };
  activeRuns: {
    interrupt(scope: string): void;
  };
  resolveOwnerScope(): Promise<{ scopeId: string; chatId: string } | null>;
  currentPolicyFingerprint(): string;
  logger: {
    info: (msg: string, ctx?: Record<string, unknown>) => void;
    warn: (msg: string, ctx?: Record<string, unknown>) => void;
    error: (msg: string, ctx?: Record<string, unknown>) => void;
  };
}

export function createHandoffHandler(deps: HandoffDeps) {
  return async function handoff(req: HandoffRequest): Promise<ControlResponse> {
    const dir = join(deps.home, '.claude', 'projects', encodeCwdForClaudeProjects(req.cwd));
    const jsonlPath = join(dir, `${req.sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) {
      return {
        ok: false,
        error: 'session-not-found',
        detail: `no jsonl at ${jsonlPath}`,
      };
    }

    const owner = await deps.resolveOwnerScope();
    if (!owner) {
      return {
        ok: false,
        error: 'owner-chat-unreachable',
        detail: 'owner p2p scope not resolvable',
      };
    }

    try {
      deps.activeRuns.interrupt(owner.scopeId);

      const prev = deps.sessions.getRaw(owner.scopeId)?.sessionId;
      if (prev && prev !== req.sessionId && deps.agent.closeSession) {
        await deps.agent.closeSession(prev);
      }

      deps.sessionCatalog.upsertActive({
        scopeId: owner.scopeId,
        agentId: 'claude',
        cwdRealpath: req.cwd,
        policyFingerprint: deps.currentPolicyFingerprint(),
        sessionId: req.sessionId,
      });
      deps.sessions.set(owner.scopeId, req.sessionId, req.cwd);

      const preview = readPreview(jsonlPath);
      const card = buildHandoffCard({
        cwd: req.cwd,
        sessionId: req.sessionId,
        firstUserMessage: preview.firstUserMessage,
        lineCount: preview.lineCount,
        mtimeMs: preview.mtimeMs,
      });
      await deps.channel.send(owner.chatId, { card });

      deps.logger.info('handoff completed', {
        scopeId: owner.scopeId,
        sessionId: req.sessionId,
        cwd: req.cwd,
      });

      return {
        ok: true,
        sessionIdShort: req.sessionId.slice(0, 8),
        scopeId: owner.scopeId,
        lineCount: preview.lineCount,
        preview: preview.firstUserMessage,
      };
    } catch (err) {
      deps.logger.error('handoff failed', {
        sessionId: req.sessionId,
        cwd: req.cwd,
        message: err instanceof Error ? err.message : String(err),
      });
      return {
        ok: false,
        error: 'bridge-internal',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
