#!/usr/bin/env node
// Fake `claude` TUI used by integration tests.
//
// Flags consumed: --session-id, --resume, --permission-mode,
//   --append-system-prompt, --model.
// Behavior is scripted via env:
//   FAKE_CLAUDE_BANNER=1 → print "Yes, I accept" startup banner
//   FAKE_CLAUDE_TURNS_JSON=<json array of arrays of entries>
//     For each prompt read on stdin, append the next array's entries to the
//     session JSONL file (one entry per line).
//   FAKE_CLAUDE_EXIT_AFTER=<n> → exit cleanly after n turns
//   FAKE_CLAUDE_CRASH_AFTER=<n> → exit 1 after n turns
//   FAKE_CLAUDE_RECORD_ARGS_PATH=<file> → write process.argv.slice(2) as JSON
//     to <file> on startup; useful for asserting flags like --permission-mode.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { posix } from 'node:path';
import { createInterface } from 'node:readline';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sessionId = arg('--session-id') ?? arg('--resume');
const cwd = process.cwd();
// Mirror src/agent/claude/jsonl-path.ts:encodeCwdForClaudeProjects.
const cleaned = posix.normalize(cwd).replace(/\/+$/, '');
const encoded = cleaned.replace(/\//g, '-');
const jsonl = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
mkdirSync(dirname(jsonl), { recursive: true });
if (!existsSync(jsonl)) writeFileSync(jsonl, '');

if (process.env.FAKE_CLAUDE_RECORD_ARGS_PATH) {
  writeFileSync(process.env.FAKE_CLAUDE_RECORD_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
}

if (process.env.FAKE_CLAUDE_BANNER) {
  process.stdout.write('Bypass Permissions mode\n  1. No\n  2. Yes, I accept\n');
}

const turns = JSON.parse(process.env.FAKE_CLAUDE_TURNS_JSON ?? '[]');
const exitAfter = Number(process.env.FAKE_CLAUDE_EXIT_AFTER ?? -1);
const crashAfter = Number(process.env.FAKE_CLAUDE_CRASH_AFTER ?? -1);

let turnIdx = 0;
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {
  const entries = turns[turnIdx] ?? [
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '(fake)' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];
  for (const e of entries) appendFileSync(jsonl, JSON.stringify(e) + '\n');
  turnIdx += 1;
  if (crashAfter >= 0 && turnIdx >= crashAfter) process.exit(1);
  if (exitAfter >= 0 && turnIdx >= exitAfter) process.exit(0);
});
