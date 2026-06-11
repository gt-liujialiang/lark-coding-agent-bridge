import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { log } from '../../core/logger';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { sessionJsonlPath } from './jsonl-path';
import { PtySession } from './pty-session';
import { ClaudePtyPool, type PtySessionLike } from './pty-pool';
import { spawnPty } from './pty';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /** Test-only: override $HOME for the JSONL path. */
  homeOverride?: string;
  /** Test-only: extra env to pass into the spawned claude. */
  env?: Record<string, string>;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly homeOverride: string | undefined;
  private readonly extraEnv: Record<string, string>;
  private botIdentity: AgentBotIdentity | undefined;
  private readonly pool: ClaudePtyPool;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
    this.homeOverride = opts.homeOverride;
    this.extraEnv = opts.env ?? {};
    this.pool = new ClaudePtyPool({
      factory: (input) => this.spawnSession(input.cwd, input.sessionId),
    });
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.pool.release(sessionId);
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for ClaudeAdapter.run');
    const cwd = opts.cwd;
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    let session: PtySession | undefined;
    let acquired: Promise<PtySession> | undefined;
    let acquiredId: string | undefined;
    const acquire = (): Promise<PtySession> => {
      if (!acquired) {
        acquired = this.pool
          .acquire({ cwd, sessionId: opts.sessionId })
          .then((s) => {
            session = s as PtySession;
            acquiredId = session.sessionId;
            return session;
          });
      }
      return acquired;
    };

    const events = (async function* (
      adapter: ClaudeAdapter,
    ): AsyncGenerator<AgentEvent> {
      let s: PtySession;
      try {
        s = await acquire();
      } catch (err) {
        yield {
          type: 'error',
          message: `failed to spawn claude: ${err instanceof Error ? err.message : String(err)}`,
          terminationReason: 'failed',
        };
        return;
      }
      // Fresh session: surface the assigned sessionId so the bridge can persist it.
      if (!opts.sessionId) {
        yield { type: 'system', sessionId: s.sessionId, cwd: s.cwd };
      }
      try {
        for await (const ev of s.runTurn(opts.prompt)) {
          yield ev;
          if (ev.type === 'error' && ev.terminationReason === 'failed') {
            await adapter.pool.release(s.sessionId);
            return;
          }
        }
      } finally {
        if (acquiredId) adapter.pool.touch(acquiredId);
      }
    })(this);

    return {
      runId: opts.runId,
      events,
      async stop() {
        if (!session) {
          try { session = await acquire(); } catch { return; }
        }
        await session.softInterrupt(stopGraceMs);
      },
      async waitForExit(_timeoutMs: number): Promise<boolean> {
        // PTY world: "exit" === "current turn done". The caller already
        // drained events before reaching here, so the turn is by definition
        // complete; the PTY itself is meant to stay alive.
        return true;
      },
    };
  }

  private async spawnSession(cwdRaw: string, sessionIdHint: string | undefined): Promise<PtySessionLike> {
    // Resolve symlinks so the JSONL path we compute matches what the claude
    // process sees from process.cwd() (e.g. /var → /private/var on macOS).
    let cwd = cwdRaw;
    try { cwd = realpathSync(cwdRaw); } catch { /* fallback to original */ }
    const sessionId = sessionIdHint ?? randomUUID();
    const resume = sessionIdHint !== undefined && existsSync(
      sessionJsonlPath({ home: this.homeOverride ?? homedir(), cwd, sessionId }),
    );

    const args = [
      '--permission-mode', CLAUDE_DEFAULT_PERMISSION_MODE,
      ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]),
      '--append-system-prompt', buildBridgeSystemPrompt(this.botIdentity),
    ];

    log.info('agent', 'claude-pty-spawn', { sessionId, cwd, resume });

    const env = {
      ...process.env,
      ...(this.homeOverride ? { HOME: this.homeOverride } : {}),
      ...buildLarkChannelEnv(this.larkChannel),
      ...this.extraEnv,
    } as Record<string, string | undefined>;

    const pty = spawnPty({ file: this.binary, args, cwd, env });
    return new PtySession({
      pty,
      cwd,
      sessionId,
      ...(this.homeOverride ? { home: this.homeOverride } : {}),
    });
  }
}
