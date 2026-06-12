export interface HandoffRequest {
  op: 'handoff';
  cwd: string;
  sessionId: string;
}

export type ControlRequest = HandoffRequest;

export interface OkResponse {
  ok: true;
  sessionIdShort: string;
  scopeId: string;
  lineCount: number;
  preview: string;
}

export interface ErrorResponse {
  ok: false;
  error:
    | 'session-not-found'
    | 'owner-chat-unreachable'
    | 'bridge-internal'
    | 'bad-request';
  detail?: string;
}

export type ControlResponse = OkResponse | ErrorResponse;

export function encodeRequest(req: ControlRequest): string {
  return JSON.stringify(req) + '\n';
}

export function decodeRequest(wire: string): ControlRequest {
  const obj = JSON.parse(wire) as Partial<HandoffRequest>;
  if (obj.op !== 'handoff') {
    throw new Error(`bad-request: unknown op "${String(obj.op)}"`);
  }
  if (typeof obj.cwd !== 'string' || !obj.cwd) {
    throw new Error('bad-request: cwd required');
  }
  if (typeof obj.sessionId !== 'string' || !obj.sessionId) {
    throw new Error('bad-request: sessionId required');
  }
  return { op: 'handoff', cwd: obj.cwd, sessionId: obj.sessionId };
}

export function encodeResponse(res: ControlResponse): string {
  return JSON.stringify(res) + '\n';
}

export function decodeResponse(wire: string): ControlResponse {
  return JSON.parse(wire) as ControlResponse;
}
