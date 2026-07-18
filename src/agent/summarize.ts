import type { ChildProcess } from 'node:child_process';
import { log } from '../core/logger';
import { spawnProcess } from '../platform/spawn';

/**
 * One-shot summary of an agent's final reply, for the compact card header.
 * Runs `claude -p <prompt> --model haiku` with the reply on stdin — a plain
 * subprocess, deliberately outside the run pool / session machinery: it
 * must never consume a concurrency slot or touch session state, and its
 * failure only degrades the card (fallback = first line), never the run.
 */
export interface SummarizeOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  spawn?: typeof spawnProcess;
}

const SUMMARY_PROMPT =
  '下面是一个 AI agent 对业务/技术问题的完整回复。' +
  '用一到两句话给出核心结论——突出原因和结果，面向在群里扫一眼消息的读者。' +
  '不要过程描述，不要开场白，不要 emoji，不要 markdown 标题，直接输出结论文本。';
const INPUT_MAX = 30_000;
const FALLBACK_MAX = 80;

/** First non-empty line, capped — used whenever the model call fails. */
export function fallbackSummary(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return firstLine.length > FALLBACK_MAX
    ? `${firstLine.slice(0, FALLBACK_MAX)}…`
    : firstLine;
}

export async function summarizeReply(
  text: string,
  opts: SummarizeOptions = {},
): Promise<string> {
  const binary = opts.binary ?? 'claude';
  const model = opts.model ?? 'haiku';
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const spawn = opts.spawn ?? spawnProcess;
  const input = text.length > INPUT_MAX ? text.slice(0, INPUT_MAX) : text;
  try {
    const raw = await runOnce(
      spawn,
      binary,
      ['-p', SUMMARY_PROMPT, '--model', model],
      input,
      timeoutMs,
    );
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
    log.warn('summarize', 'empty-output', { model });
  } catch (err) {
    log.warn('summarize', 'failed', { model, err: String(err) });
  }
  return fallbackSummary(text);
}

function runOnce(
  spawn: typeof spawnProcess,
  binary: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL');
        reject(new Error(`summarize timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer | string) => {
      out += String(d);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) =>
      settle(() => {
        if (code === 0) resolve(out);
        else reject(new Error(`summarize exited with code ${code}`));
      }),
    );
    child.stdin?.write(input);
    child.stdin?.end();
  });
}
