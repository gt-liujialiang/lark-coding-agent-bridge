import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { log } from '../../core/logger';
import type { AgentEvent, TurnSnapshot } from '../types';
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
  /**
   * Idle checkpoint cadence (ms). The Nth entry is how long the JSONL must stay
   * silent before the Nth `idle_checkpoint` event fires; after the array is
   * exhausted, the last value repeats. Default: 10min → 30min → 60min → 60min …
   *
   * Checkpoints never terminate the turn — they only surface a status snapshot
   * for the caller to act on (e.g. send a "still waiting?" card to the user).
   * Any new JSONL activity, or a `resetIdleCheckpoint()` call, restarts the
   * cadence from the first threshold.
   */
  idleCheckpointsMs?: readonly number[];
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
// Default check-in cadence: nudge the caller after 10 min of JSONL silence,
// then back off to 30 min, then settle at 60 min repeats. The turn keeps
// running across all of these — these are notifications, not deadlines.
const DEFAULT_IDLE_CHECKPOINTS_MS: readonly number[] = [
  10 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
] as const;
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
  // Per-turn observability — populated while runTurn is active, cleared otherwise.
  private translator: JsonlTurnTranslator | null = null;
  private turnStartedAt = 0;
  private lastEntryAt = 0;
  // Flipped by `resetIdleCheckpoint()`; the runTurn loop drains it next tick.
  private idleCheckpointResetRequested = false;

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
   * Deliver an answer to a pending `AskUserQuestion` menu by writing the
   * corresponding keystrokes to the PTY. claude's TUI internally synthesises
   * the `tool_result`; our JSONL poll loop will see it next tick and resume
   * normal event emission.
   *
   * Keystroke protocol (probed against claude 2.1.150):
   * - single-select: type the option's 1-based index ("3"). claude auto-
   *   advances to the next question.
   * - multi-select: type each chosen option's 1-based index, then `Tab` to
   *   move focus to the Submit pill. claude auto-advances on Submit.
   * - submit / finalize the whole batch: a final `Enter` once all questions
   *   are answered (`isLastQuestion: true`).
   *
   * Selections are 0-based option indices in the original input order.
   */
  async answerAskUserQuestion(input: {
    toolUseId: string;
    selections: number[];
    multiSelect: boolean;
    isLastQuestion: boolean;
  }): Promise<void> {
    if (!this.alive) {
      log.warn('agent', 'claude-aq-answer-dead', {
        sessionId: this.opts.sessionId,
        toolUseId: input.toolUseId,
      });
      return;
    }
    if (input.selections.length === 0) {
      // Defensive: nothing to toggle. Don't write anything; the caller is
      // probably mishandling an empty selection. We could Esc-cancel, but
      // that would abort the whole AskUserQuestion — leave the decision to
      // the caller. Just log.
      log.warn('agent', 'claude-aq-empty-selections', {
        sessionId: this.opts.sessionId,
        toolUseId: input.toolUseId,
      });
      return;
    }
    // 0-based selections → 1-based menu indices. Multi-digit numbers
    // (>9 options) aren't supported by the TUI as direct numeric input, so
    // we cap at 9; callers above this size should fall back to navigation
    // keys, which we don't implement yet.
    const keys: string[] = [];
    for (const idx of input.selections) {
      const oneBased = idx + 1;
      if (oneBased < 1 || oneBased > 9) {
        log.warn('agent', 'claude-aq-index-out-of-range', {
          sessionId: this.opts.sessionId,
          toolUseId: input.toolUseId,
          idx,
        });
        continue;
      }
      keys.push(String(oneBased));
    }
    if (input.multiSelect) keys.push('\t');
    if (input.isLastQuestion) keys.push('\r');

    log.info('agent', 'claude-aq-answer', {
      sessionId: this.opts.sessionId,
      toolUseId: input.toolUseId,
      selections: input.selections,
      multiSelect: input.multiSelect,
      isLastQuestion: input.isLastQuestion,
      payloadHex: Buffer.from(keys.join('')).toString('hex'),
    });
    // Send each keystroke as its own PTY write with a small gap. claude TUI
    // runs in bracketed-paste mode: a burst of bytes arriving in one read is
    // treated as a *paste* rather than discrete keypresses, which means Tab
    // and Enter get absorbed as characters in the paste buffer instead of
    // navigating + submitting. Writing one byte per write with ~80ms gaps
    // makes the TUI see distinct keystrokes. (Same root cause as the
    // bracketed-paste workaround for sending prompts.)
    for (let i = 0; i < keys.length; i++) {
      this.opts.pty.write(keys[i]!);
      if (i < keys.length - 1) await delay(80);
    }
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
      this.translator = new JsonlTurnTranslator();
      this.turnStartedAt = Date.now();
      this.lastEntryAt = Date.now();
      this.idleCheckpointResetRequested = false;
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
      const checkpointDeltas = this.opts.idleCheckpointsMs ?? DEFAULT_IDLE_CHECKPOINTS_MS;
      let firedCheckpoints = 0;
      let nextCheckpointAt = Date.now() + checkpointDeltas[0]!;
      const restartCheckpointCadence = (): void => {
        firedCheckpoints = 0;
        nextCheckpointAt = Date.now() + checkpointDeltas[0]!;
      };

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
        if (entries.length > 0) {
          this.lastEntryAt = Date.now();
          restartCheckpointCadence();
        }
        for (const e of entries) {
          for (const ev of this.translator.translate(e)) {
            yield ev;
            if (ev.type === 'done') return;
          }
        }
        if (this.interruptRequested) {
          yield { type: 'done', terminationReason: 'interrupted' };
          return;
        }
        if (this.idleCheckpointResetRequested) {
          this.idleCheckpointResetRequested = false;
          this.lastEntryAt = Date.now();
          restartCheckpointCadence();
        }
        if (Date.now() >= nextCheckpointAt) {
          firedCheckpoints += 1;
          const snap = this.snapshot();
          if (snap) {
            yield {
              type: 'idle_checkpoint',
              idleMs: Date.now() - this.lastEntryAt,
              checkpointNumber: firedCheckpoints,
              snapshot: snap,
            };
          }
          const nextIdx = Math.min(firedCheckpoints, checkpointDeltas.length - 1);
          nextCheckpointAt = Date.now() + checkpointDeltas[nextIdx]!;
        }
        await delay(pollMs);
      }
    } finally {
      this.busy = false;
      this.translator = null;
    }
  }

  /**
   * Snapshot of the currently running turn — null when no turn is active.
   * Combines wall-clock timing (turn start, last JSONL activity) with the
   * translator's per-turn state (in-flight tools, latest todo list, text tail,
   * tokens). Safe to call from any thread/event handler; reads only the
   * snapshot of internal state and does not mutate anything.
   */
  snapshot(): TurnSnapshot | null {
    if (!this.translator) return null;
    const t = this.translator.snapshot();
    return {
      turnStartedAt: this.turnStartedAt,
      lastEntryAt: this.lastEntryAt,
      entriesSeen: t.entriesSeen,
      inFlightTools: t.inFlightTools,
      lastCompletedTool: t.lastCompletedTool,
      lastTextTail: t.lastTextTail,
      todos: t.todos,
      tokens: t.tokens,
    };
  }

  /**
   * Tell the runTurn loop to behave as if the JSONL just received new activity:
   * resets the idle baseline and the checkpoint backoff. Use this when the user
   * has responded to a check-in card with "keep waiting" — the next checkpoint
   * should fire after the *first* threshold again, not the backed-off one.
   */
  resetIdleCheckpoint(): void {
    this.idleCheckpointResetRequested = true;
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
