import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { startControlSocket } from '../../../src/runtime/control-socket.js';
import {
  encodeRequest,
  type ControlResponse,
} from '../../../src/runtime/control-protocol.js';

function clientRoundTrip(socketPath: string, reqWire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(socketPath, () => c.write(reqWire));
    const chunks: Buffer[] = [];
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    c.on('error', reject);
  });
}

describe('control socket', () => {
  it('dispatches handoff request to handler and returns response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-sock-'));
    const sockPath = join(dir, 'control.sock');
    let captured: unknown = null;
    const server = await startControlSocket({
      socketPath: sockPath,
      handlers: {
        handoff: async (req) => {
          captured = req;
          return {
            ok: true,
            sessionIdShort: 'abc-1234',
            scopeId: 'p2p:oc_test',
            lineCount: 7,
            preview: 'hi',
          };
        },
      },
    });
    try {
      const wire = await clientRoundTrip(
        sockPath,
        encodeRequest({ op: 'handoff', cwd: '/x', sessionId: 'abc-1234' }),
      );
      const res = JSON.parse(wire) as ControlResponse;
      expect(res.ok).toBe(true);
      expect(captured).toEqual({ op: 'handoff', cwd: '/x', sessionId: 'abc-1234' });
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns bad-request when handler input is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-sock-'));
    const sockPath = join(dir, 'control.sock');
    const server = await startControlSocket({
      socketPath: sockPath,
      handlers: { handoff: async () => ({ ok: true, sessionIdShort: '', scopeId: '', lineCount: 0, preview: '' }) },
    });
    try {
      const wire = await clientRoundTrip(sockPath, 'not-json\n');
      const res = JSON.parse(wire) as ControlResponse;
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('bad-request');
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlinks stale socket on startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcb-sock-'));
    const sockPath = join(dir, 'control.sock');
    const a = await startControlSocket({
      socketPath: sockPath,
      handlers: { handoff: async () => ({ ok: true, sessionIdShort: '', scopeId: '', lineCount: 0, preview: '' }) },
    });
    await a.close({ unlink: false }); // simulate crash: socket file remains
    const b = await startControlSocket({
      socketPath: sockPath,
      handlers: { handoff: async () => ({ ok: true, sessionIdShort: 'ok', scopeId: 'p2p:x', lineCount: 0, preview: '' }) },
    });
    try {
      const wire = await clientRoundTrip(
        sockPath,
        encodeRequest({ op: 'handoff', cwd: '/x', sessionId: 'y' }),
      );
      const res = JSON.parse(wire) as ControlResponse;
      expect(res.ok).toBe(true);
    } finally {
      await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
