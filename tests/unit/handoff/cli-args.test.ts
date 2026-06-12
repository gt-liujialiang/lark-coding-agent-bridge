import { describe, expect, it } from 'vitest';
import { parseHandoffArgs } from '../../../src/cli/commands/handoff.js';

describe('handoff cli args', () => {
  it('returns defaults when no flags', () => {
    const opts = parseHandoffArgs({});
    expect(opts.list).toBe(false);
    expect(opts.session).toBeUndefined();
  });

  it('accepts --session', () => {
    expect(parseHandoffArgs({ session: 'abc' }).session).toBe('abc');
  });

  it('accepts --list', () => {
    expect(parseHandoffArgs({ list: true }).list).toBe(true);
  });

  it('rejects --session combined with --list', () => {
    expect(() => parseHandoffArgs({ session: 'abc', list: true })).toThrow(
      /mutually exclusive/i,
    );
  });
});
