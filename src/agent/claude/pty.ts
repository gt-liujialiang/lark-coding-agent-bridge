import * as nodePty from 'node-pty';

export interface PtyHandle {
  pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnPtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
}

/**
 * Thin wrapper around `node-pty` so the rest of the adapter can be unit-tested
 * against a stub PTY. Defaults to 220x200 to match `seed-offline-tasks` —
 * Claude's TUI uses screen width for line wrapping which affects the rolling
 * permission-detection buffer.
 */
export function spawnPty(opts: SpawnPtyOptions): PtyHandle {
  const filteredEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string') filteredEnv[k] = v;
  }
  const cols = opts.cols ?? 220;
  const rows = opts.rows ?? 200;
  const proc = nodePty.spawn(opts.file, opts.args, {
    cwd: opts.cwd,
    env: {
      ...filteredEnv,
      TERM: 'xterm-256color',
      COLUMNS: String(cols),
      LINES: String(rows),
    },
    cols,
    rows,
  });
  return {
    get pid() {
      return proc.pid;
    },
    write: (data) => proc.write(data),
    resize: (c, r) => proc.resize(c, r),
    onData: (listener) => {
      proc.onData(listener);
    },
    onExit: (listener) => {
      proc.onExit((e) => listener({ exitCode: e.exitCode, signal: e.signal }));
    },
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        // node-pty throws if the process is already gone; treat as no-op.
      }
    },
  };
}
