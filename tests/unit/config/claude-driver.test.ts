import { describe, expect, it } from 'vitest';
import { getClaudeDriver, type AppConfig } from '../../../src/config/schema.js';

function cfg(driver?: string): AppConfig {
  return {
    preferences: driver !== undefined ? { claudeDriver: driver as 'pty' | 'headless' } : undefined,
  } as AppConfig;
}

describe('getClaudeDriver', () => {
  it('defaults to pty when no preference is set', () => {
    expect(getClaudeDriver(cfg(undefined))).toBe('pty');
    expect(getClaudeDriver({ preferences: {} } as AppConfig)).toBe('pty');
  });

  it('returns headless when explicitly set', () => {
    expect(getClaudeDriver(cfg('headless'))).toBe('headless');
  });

  it('returns pty when explicitly set', () => {
    expect(getClaudeDriver(cfg('pty'))).toBe('pty');
  });

  it('returns pty for unknown values (forward compatible)', () => {
    expect(getClaudeDriver(cfg('unknown'))).toBe('pty');
  });
});
