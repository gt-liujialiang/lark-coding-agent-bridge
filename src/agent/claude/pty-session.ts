import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { log } from '../../core/logger';
import type { AgentEvent } from '../types';
import { sessionJsonlPath } from './jsonl-path';
import { JsonlReader } from './jsonl-reader';
import { JsonlTurnTranslator } from './jsonl-translate';
import type { PtyHandle } from './pty';

export interface PtySessionOptions {
  pty: PtyHandle;
  cwd: string;
  sessionId: string;
  /** Override $HOME (useful for tests). */
  home?: string;
  /** JSONL poll interval (ms). Default 300. */
  pollMs?: number;
  /** Delay between prompt body and trailing CR. Default 200ms. */
  promptDelayMs?: number;
  /** Max turn duration (ms) before soft-interrupt + timeout error. */
  maxTurnMs?: number;
  /** Quiet-window required for first-turn readiness. Default 1000ms. */
  readinessQuietMs?: number;
  /** Max wait for first-turn readiness. Default 30000ms. */
  readinessMaxMs?: number;
}

// Startup consent dialogs claude shows on first use of a cwd / mode.
// Each pattern is matched against the (ANSI-stripped) rolling PTY buffer.
// On match we send `response`, and the dialog is treated as "handled" so we
// don't re-press if the same text reappears in scrollback.
interface ConsentDialog {
  name: string;
  pattern: RegExp;
  response: string;
}
const CONSENT_DIALOGS: ConsentDialog[] = [
  // "Quick safety check: Is this a project you trust?" — first time in a cwd.
  //   1. Yes, I trust this folder   2. No, exit   Enter to confirm
  // Default highlight is option 1; \r confirms.
  { name: 'trust-folder', pattern: /Yes,\s*I\s*trust\s*this\s*folder/i, response: '\r' },
  // "Bypass Permissions mode" warning — first time under --permission-mode bypassPermissions.
  //   1. No, exit   2. Yes, I accept
  { name: 'bypass-permissions', pattern: /Yes,\s*I\s*accept/i, response: '2\r' },
];

const ROLLING_BUFFER_BYTES = 8192;
const DEFAULT_POLL_MS = 300;
const DEFAULT_PROMPT_DELAY_MS = 200;
const DEFAULT_MAX_TURN_MS = 10 * 60 * 1000;
const READINESS_MAX_MS = 30_000;
const READINESS_QUIET_MS = 1_000;

// Strip CSI / OSC / other ANSI escape sequences from PTY output so error
// messages we surface to users are readable plain text.
function stripAnsi(s: string): string {
  return s.replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?(?:\x1b\\|\x07)|[@-Z\\-_])/g,
    '',
  );
}

export class PtySession {
  private readonly jsonlPath: string;
  private readonly reader: JsonlReader;
  private rollingBuffer = '';
  private readonly handledDialogs = new Set<string>();
  private lastDataAt = 0;
  private firstReady = false;
  private alive = true;
  private exitInfo: { exitCode: number; signal?: number } | undefined;
  private busy = false;
  private interruptRequested = false;

  private readonly debugDumpPath: string | undefined;

  constructor(private readonly opts: PtySessionOptions) {
    const home = opts.home ?? homedir();
    this.jsonlPath = sessionJsonlPath({ home, cwd: opts.cwd, sessionId: opts.sessionId });
    this.reader = new JsonlReader(this.jsonlPath);
    // Set CLAUDE_PTY_DEBUG_DIR=/tmp/claude-pty-debug to capture raw PTY output
    // per session for postmortem of "stuck" turns. Off by default.
    const debugDir = process.env.CLAUDE_PTY_DEBUG_DIR;
    if (debugDir) {
      try {
        mkdirSync(debugDir, { recursive: true });
        this.debugDumpPath = join(debugDir, `${opts.sessionId}.pty`);
      } catch { /* ignore */ }
    }

    opts.pty.onData((s) => this.handleData(s));
    opts.pty.onExit((e) => {
      this.alive = false;
      this.exitInfo = e;
      const tail = stripAnsi(this.rollingBuffer).trim().slice(-800);
      log.warn('agent', 'claude-pty-exit', {
        sessionId: this.opts.sessionId,
        exitCode: e.exitCode,
        signal: e.signal,
        tail: tail || undefined,
      });
    });
  }

  get sessionId(): string {
    return this.opts.sessionId;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  isAlive(): boolean {
    return this.alive;
  }

  private handleData(s: string): void {
    if (this.debugDumpPath) {
      try { appendFileSync(this.debugDumpPath, s); } catch { /* ignore */ }
    }
    this.rollingBuffer = (this.rollingBuffer + s).slice(-ROLLING_BUFFER_BYTES);
    this.lastDataAt = Date.now();
    // Strip ANSI before matching dialogs — claude wraps option labels with
    // color/style codes that can otherwise split the substring we look for.
    const visible = stripAnsi(this.rollingBuffer);
    for (const dialog of CONSENT_DIALOGS) {
      if (this.handledDialogs.has(dialog.name)) continue;
      if (dialog.pattern.test(visible)) {
        this.handledDialogs.add(dialog.name);
        log.info('agent', 'claude-consent', {
          sessionId: this.opts.sessionId,
          dialog: dialog.name,
        });
        // Brief delay so the dialog finishes rendering before our key lands.
        setTimeout(() => this.opts.pty.write(dialog.response), 100);
      }
    }
  }

  /**
   * Block until claude's TUI is past its boot screen and any consent dialogs
   * so the first prompt isn't eaten. We treat "no PTY data for
   * READINESS_QUIET_MS, after we've seen *some* data" as ready. If a consent
   * dialog handler fires, the quiet-window timer resets — its keystroke
   * causes a redraw, and we wait for the next quiet period.
   */
  private async waitForReady(): Promise<void> {
    if (this.firstReady) return;
    const quietMs = this.opts.readinessQuietMs ?? READINESS_QUIET_MS;
    const maxMs = this.opts.readinessMaxMs ?? READINESS_MAX_MS;
    const deadline = Date.now() + maxMs;
    // Need at least *some* data before we declare ready (rules out the case
    // where claude hasn't drawn anything yet but is mid-boot). If the caller
    // configured quietMs=0, skip this gate entirely (test mode).
    if (quietMs > 0) {
      while (this.lastDataAt === 0 && Date.now() < deadline) {
        await delay(10);
      }
    }
    while (Date.now() < deadline) {
      const idle = Date.now() - this.lastDataAt;
      if (idle >= quietMs) {
        this.firstReady = true;
        return;
      }
      await delay(Math.max(10, quietMs - idle));
    }
    // Timed out — proceed anyway; caller may still succeed.
    log.warn('agent', 'claude-pty-ready-timeout', {
      sessionId: this.opts.sessionId,
      bufferTail: stripAnsi(this.rollingBuffer).trim().slice(-200),
    });
    this.firstReady = true;
  }

  /**
   * Initialize the reader's cursor to the current JSONL line count. Used by
   * the pool when reusing an existing PTY for a new turn so the next turn
   * starts past whatever already lives in the log.
   */
  async syncCursorToTail(): Promise<void> {
    const { lineCount } = await this.reader.readNew();
    this.reader.setCursor(lineCount);
  }

  /**
   * Drives one turn: write prompt → poll JSONL → translate → emit events
   * until either `stop_reason: end_turn`, PTY exit, soft-interrupt resolution,
   * or watchdog timeout.
   */
  async *runTurn(prompt: string): AsyncIterable<AgentEvent> {
    if (this.busy) throw new Error('PtySession.runTurn called while previous turn is running');
    this.busy = true;
    try {
      // First turn only: wait for claude's TUI to finish booting (and any
      // consent dialogs to be handled) before writing the prompt. Otherwise
      // our keystrokes get eaten by the boot/dialog and the prompt never
      // submits.
      await this.waitForReady();

      await this.syncCursorToTail();
      const translator = new JsonlTurnTranslator();
      this.interruptRequested = false;

      // claude's TUI treats `\n` in input as "newline in multi-line input
      // buffer", and in that multi-line state `\r` is also "add another
      // line" instead of Submit. To force unambiguous submission we collapse
      // every `\n` to a literal space — the prompt is still semantically
      // identical for the LLM (it strips redundant whitespace anyway), but
      // claude sees one logical line followed by Submit.
      const singleLinePrompt = prompt.replace(/\r?\n/g, ' ');
      this.opts.pty.write(singleLinePrompt);
      await delay(this.opts.promptDelayMs ?? DEFAULT_PROMPT_DELAY_MS);
      this.opts.pty.write('\r');

      const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
      const deadline = Date.now() + (this.opts.maxTurnMs ?? DEFAULT_MAX_TURN_MS);

      while (true) {
        if (!this.alive) {
          const tail = stripAnsi(this.rollingBuffer).trim().slice(-800);
          const detail = tail ? `: ${tail}` : '';
          yield {
            type: 'error',
            message: `claude PTY exited (code ${this.exitInfo?.exitCode ?? '?'}${this.exitInfo?.signal ? `, signal ${this.exitInfo.signal}` : ''})${detail}`,
            terminationReason: 'failed',
          };
          return;
        }
        const { entries } = await this.reader.readNew();
        for (const e of entries) {
          for (const ev of translator.translate(e)) {
            yield ev;
            if (ev.type === 'done') return;
          }
        }
        if (this.interruptRequested) {
          yield { type: 'done', terminationReason: 'interrupted' };
          return;
        }
        if (Date.now() > deadline) {
          this.opts.pty.write('\x1b');
          yield {
            type: 'error',
            message: 'claude turn exceeded max duration',
            terminationReason: 'timeout',
          };
          return;
        }
        await delay(pollMs);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Soft-interrupt: write ESC and ask the current `runTurn` loop to resolve
   * as `done(interrupted)` within `graceMs`. PTY stays alive — next turn can
   * reuse it.
   */
  async softInterrupt(graceMs = 5000): Promise<void> {
    if (!this.alive) return;
    this.opts.pty.write('\x1b');
    this.interruptRequested = true;
    await delay(graceMs);
  }

  /**
   * Hard close: SIGTERM, wait up to graceMs, SIGKILL if still alive. After
   * this call, the session is unusable and must be evicted from the pool.
   */
  async hardClose(graceMs = 3000): Promise<void> {
    if (!this.alive) return;
    this.opts.pty.kill('SIGTERM');
    const startedAt = Date.now();
    while (this.alive && Date.now() - startedAt < graceMs) {
      await delay(50);
    }
    if (this.alive) this.opts.pty.kill('SIGKILL');
  }
}
