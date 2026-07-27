import { describe, expect, it } from 'vitest';
import { getClaudeP2pAutoApprove, type AppConfig } from '../../../src/config/schema.js';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 'x', tenant: 'feishu' } },
    preferences,
  };
}

describe('getClaudeP2pAutoApprove', () => {
  it('defaults to true when unset', () => {
    expect(getClaudeP2pAutoApprove(cfg(undefined))).toBe(true);
    expect(getClaudeP2pAutoApprove(cfg({}))).toBe(true);
  });

  it('returns true when explicitly true', () => {
    expect(getClaudeP2pAutoApprove(cfg({ claudeP2pAutoApprove: true }))).toBe(true);
  });

  it('returns false only when explicitly false', () => {
    expect(getClaudeP2pAutoApprove(cfg({ claudeP2pAutoApprove: false }))).toBe(false);
  });
});
