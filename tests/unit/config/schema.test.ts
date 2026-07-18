import { describe, expect, it } from 'vitest';
import {
  getReplyInThreadInGroup,
  resolveCardStyle,
  getCardStylePref,
} from '../../../src/config/schema.js';
import type { AppConfig } from '../../../src/config/schema.js';

function cfgWith(replyInThreadInGroup: boolean | undefined): AppConfig {
  return {
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    preferences: replyInThreadInGroup === undefined ? {} : { replyInThreadInGroup },
  } as AppConfig;
}

describe('getReplyInThreadInGroup', () => {
  it('defaults to true when unset', () => {
    expect(getReplyInThreadInGroup(cfgWith(undefined))).toBe(true);
  });

  it('returns false only when explicitly false', () => {
    expect(getReplyInThreadInGroup(cfgWith(false))).toBe(false);
  });

  it('returns true when explicitly true', () => {
    expect(getReplyInThreadInGroup(cfgWith(true))).toBe(true);
  });
});

describe('cardStyle preference', () => {
  const base = {
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
  } as AppConfig;
  const withStyle = (v: unknown): AppConfig =>
    ({ ...base, preferences: { cardStyle: v } }) as AppConfig;

  it('defaults to auto: p2p → streaming, group/topic → compact', () => {
    expect(resolveCardStyle(base, 'p2p')).toBe('streaming');
    expect(resolveCardStyle(base, 'group')).toBe('compact');
    expect(resolveCardStyle(base, 'topic')).toBe('compact');
  });

  it('explicit streaming/compact applies to every chat mode', () => {
    for (const mode of ['p2p', 'group', 'topic'] as const) {
      expect(resolveCardStyle(withStyle('streaming'), mode)).toBe('streaming');
      expect(resolveCardStyle(withStyle('compact'), mode)).toBe('compact');
    }
  });

  it('unknown values fall back to auto behavior', () => {
    expect(resolveCardStyle(withStyle('bogus'), 'p2p')).toBe('streaming');
    expect(resolveCardStyle(withStyle('bogus'), 'group')).toBe('compact');
  });

  it('getCardStylePref returns the raw 3-state with auto default', () => {
    expect(getCardStylePref(base)).toBe('auto');
    expect(getCardStylePref(withStyle('compact'))).toBe('compact');
    expect(getCardStylePref(withStyle('bogus'))).toBe('auto');
  });
});
