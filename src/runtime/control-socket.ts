import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import {
  decodeRequest,
  encodeResponse,
  type ControlResponse,
  type HandoffRequest,
} from './control-protocol.js';

export interface ControlHandlers {
  handoff: (req: HandoffRequest) => Promise<ControlResponse>;
}

export interface ControlSocketServer {
  close(opts?: { unlink?: boolean }): Promise<void>;
}

export interface StartControlSocketOptions {
  socketPath: string;
  handlers: ControlHandlers;
}

export async function startControlSocket(
  opts: StartControlSocketOptions,
): Promise<ControlSocketServer> {
  // Unlink stale socket file from a prior crashed bridge before binding.
  try {
    unlinkSync(opts.socketPath);
  } catch {
    // not present — fine
  }

  const server: Server = createServer((sock) => handleConnection(sock, opts.handlers));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    chmodSync(opts.socketPath, 0o600);
  } catch {
    // best-effort
  }

  return {
    async close(closeOpts) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (closeOpts?.unlink !== false) {
        try {
          unlinkSync(opts.socketPath);
        } catch {
          // already gone
        }
      }
    },
  };
}

function handleConnection(sock: Socket, handlers: ControlHandlers): void {
  const chunks: Buffer[] = [];
  let handled = false;

  const tryProcess = (): void => {
    if (handled) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    // Process as soon as we have a newline-terminated message.
    if (raw.includes('\n')) {
      handled = true;
      void respond(sock, raw, handlers);
    }
  };

  sock.on('data', (d) => {
    chunks.push(d);
    tryProcess();
  });
  sock.on('end', () => {
    // Also process on EOF in case the client closes without a newline.
    if (!handled) {
      handled = true;
      void respond(sock, Buffer.concat(chunks).toString('utf8'), handlers);
    }
  });
  sock.on('error', () => {
    // ignore client-side close
  });
}

async function respond(
  sock: Socket,
  wire: string,
  handlers: ControlHandlers,
): Promise<void> {
  let response: ControlResponse;
  try {
    const req = decodeRequest(wire);
    response = await handlers.handoff(req);
  } catch (err) {
    response = {
      ok: false,
      error: 'bad-request',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  sock.end(encodeResponse(response));
}
