import { homedir } from 'node:os';
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
}

const ACCEPT_TRIGGER = 'I accept';
const ROLLING_BUFFER_BYTES = 4096;
const DEFAULT_POLL_MS = 300;
const DEFAULT_PROMPT_DELAY_MS = 200;
const DEFAULT_MAX_TURN_MS = 10 * 60 * 1000;

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
  private acceptPressed = false;
  private alive = true;
  private exitInfo: { exitCode: number; signal?: number } | undefined;
  private busy = false;
  private interruptRequested = false;

  constructor(private readonly opts: PtySessionOptions) {
    const home = opts.home ?? homedir();
    this.jsonlPath = sessionJsonlPath({ home, cwd: opts.cwd, sessionId: opts.sessionId });
    this.reader = new JsonlReader(this.jsonlPath);

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
    this.rollingBuffer = (this.rollingBuffer + s).slice(-ROLLING_BUFFER_BYTES);
    if (!this.acceptPressed && this.rollingBuffer.includes(ACCEPT_TRIGGER)) {
      this.acceptPressed = true;
      this.opts.pty.write('2\r');
      log.info('agent', 'claude-bypass-accept', { sessionId: this.opts.sessionId });
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
      await this.syncCursorToTail();
      const translator = new JsonlTurnTranslator();
      this.interruptRequested = false;

      this.opts.pty.write(prompt);
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
