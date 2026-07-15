import { describe, expect, it } from 'vitest';
import { getConclusionFocus, getReplyInThreadInGroup } from '../../../src/config/schema.js';
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

function cfgWithConclusion(conclusionFocus: boolean | undefined): AppConfig {
  return {
    accounts: { app: { id: 'a', secret: 's', tenant: 'feishu' } },
    preferences: conclusionFocus === undefined ? {} : { conclusionFocus },
  } as AppConfig;
}

describe('getConclusionFocus', () => {
  it('defaults to false when unset', () => {
    expect(getConclusionFocus(cfgWithConclusion(undefined))).toBe(false);
  });

  it('returns true only when explicitly true', () => {
    expect(getConclusionFocus(cfgWithConclusion(true))).toBe(true);
    expect(getConclusionFocus(cfgWithConclusion(false))).toBe(false);
  });
});
