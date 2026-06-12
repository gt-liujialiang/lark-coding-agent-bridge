import { connect } from 'node:net';
import { join } from 'node:path';
import { platform, homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { encodeCwdForClaudeProjects } from '../../agent/claude/jsonl-path.js';
import { pickLatest, listCandidates } from '../../agent/claude/jsonl-scan.js';
import {
  encodeRequest,
  decodeResponse,
  type ControlResponse,
} from '../../runtime/control-protocol.js';

export interface HandoffOpts {
  session?: string;
  list?: boolean;
  cwd?: string;
  profile?: string;
}

export interface ParsedHandoffOpts {
  session: string | undefined;
  list: boolean;
  cwd: string | undefined;
  profile: string | undefined;
}

export function parseHandoffArgs(raw: HandoffOpts): ParsedHandoffOpts {
  if (raw.session && raw.list) {
    throw new Error('--session and --list are mutually exclusive');
  }
  return {
    session: raw.session,
    list: raw.list === true,
    cwd: raw.cwd,
    profile: raw.profile,
  };
}

export async function runHandoff(raw: HandoffOpts): Promise<number> {
  if (platform() === 'win32') {
    process.stderr.write(
      'handoff is not supported on Windows. Use `claude --resume <id>` locally instead.\n',
    );
    return 1;
  }
  const opts = parseHandoffArgs(raw);
  const cwd = opts.cwd ?? process.cwd();
  const home = homedir();

  if (opts.list) {
    return printCandidatesAndExit({ home, cwd });
  }

  const candidate = opts.session
    ? opts.session
    : pickLatest({ home, cwd })?.sessionId;

  if (!candidate) {
    const dir = join(home, '.claude', 'projects', encodeCwdForClaudeProjects(cwd));
    process.stderr.write(`no claude session jsonl found under ${dir}\n`);
    return 1;
  }

  const socketPath = await resolveSocketPath(opts.profile);
  if (!socketPath || !existsSync(socketPath)) {
    process.stderr.write(
      `bridge not running. start it with 'lark-channel-bridge start${opts.profile ? ` --profile ${opts.profile}` : ''}'\n`,
    );
    return 1;
  }

  try {
    const res = await sendRequest(socketPath, { op: 'handoff', cwd, sessionId: candidate });
    if (res.ok) {
      process.stdout.write(
        `已推送会话 ${res.sessionIdShort} 到飞书私聊（${res.lineCount} 条对话）。\n`,
      );
      return 0;
    }
    process.stderr.write(`handoff failed: ${res.error}${res.detail ? `\n${res.detail}` : ''}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `failed to talk to bridge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

function printCandidatesAndExit(args: { home: string; cwd: string }): number {
  const entries = listCandidates({ ...args, limit: 10 });
  if (entries.length === 0) {
    process.stdout.write('no candidates\n');
    return 0;
  }
  for (const e of entries) {
    const ago = Math.floor((Date.now() - e.mtimeMs) / 1000);
    process.stdout.write(`${e.sessionId}  (${ago}s ago)\n`);
  }
  return 0;
}

async function resolveSocketPath(profileName: string | undefined): Promise<string | undefined> {
  const { resolveProfileDir } = await import('../../runtime/profile-discovery.js');
  const dir = await resolveProfileDir(profileName);
  if (!dir) return undefined;
  return join(dir, 'control.sock');
}

function sendRequest(
  socketPath: string,
  req: { op: 'handoff'; cwd: string; sessionId: string },
): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => sock.end(encodeRequest(req)));
    const chunks: Buffer[] = [];
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      try {
        resolve(decodeResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', reject);
  });
}
