import { describe, expect, it } from 'vitest';
import {
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  type ControlRequest,
  type ControlResponse,
} from '../../../src/runtime/control-protocol.js';

describe('control protocol', () => {
  it('round-trips a handoff request', () => {
    const req: ControlRequest = {
      op: 'handoff',
      cwd: '/Users/test/proj',
      sessionId: 'abc-1234',
    };
    const wire = encodeRequest(req);
    expect(wire.endsWith('\n')).toBe(true);
    expect(decodeRequest(wire)).toEqual(req);
  });

  it('round-trips an ok response', () => {
    const res: ControlResponse = {
      ok: true,
      sessionIdShort: 'abc-1234',
      scopeId: 'p2p:oc_xxx',
      lineCount: 47,
      preview: 'topic',
    };
    expect(decodeResponse(encodeResponse(res))).toEqual(res);
  });

  it('round-trips an error response', () => {
    const res: ControlResponse = {
      ok: false,
      error: 'session-not-found',
      detail: 'no jsonl',
    };
    expect(decodeResponse(encodeResponse(res))).toEqual(res);
  });

  it('decodeRequest throws on malformed JSON', () => {
    expect(() => decodeRequest('not-json\n')).toThrow();
  });

  it('decodeRequest throws on missing op', () => {
    expect(() => decodeRequest(JSON.stringify({}) + '\n')).toThrow();
  });
});
