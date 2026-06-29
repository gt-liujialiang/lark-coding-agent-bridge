import { describe, expect, it } from 'vitest';
import { getShowToolCalls, getToolCallDisplay, type AppConfig } from '../../../src/config/schema.js';

function cfg(preferences: AppConfig['preferences']): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 'x', tenant: 'feishu' } },
    preferences,
  };
}

describe('getToolCallDisplay', () => {
  it('defaults to compact when no preference is set', () => {
    expect(getToolCallDisplay(cfg(undefined), false)).toBe('compact');
    expect(getToolCallDisplay(cfg(undefined), true)).toBe('compact');
  });

  it('honors the base toolCallDisplay in both p2p and group', () => {
    expect(getToolCallDisplay(cfg({ toolCallDisplay: 'compact' }), false)).toBe('compact');
    expect(getToolCallDisplay(cfg({ toolCallDisplay: 'compact' }), true)).toBe('compact');
  });

  it('uses the group override only when isGroup is true', () => {
    const c = cfg({ toolCallDisplay: 'full', toolCallDisplayInGroups: 'compact' });
    expect(getToolCallDisplay(c, false)).toBe('full');
    expect(getToolCallDisplay(c, true)).toBe('compact');
  });

  it('ignores invalid override values and falls back to the base', () => {
    const c = cfg({
      toolCallDisplay: 'compact',
      toolCallDisplayInGroups: 'bogus' as never,
    });
    expect(getToolCallDisplay(c, true)).toBe('compact');
  });

  it('migrates legacy showToolCalls=false to hide when no tri-state is set', () => {
    expect(getToolCallDisplay(cfg({ showToolCalls: false }), false)).toBe('hide');
    expect(getToolCallDisplay(cfg({ showToolCalls: false }), true)).toBe('hide');
  });

  it('treats legacy showToolCalls=true as the compact default (only ever meant "show tools")', () => {
    expect(getToolCallDisplay(cfg({ showToolCalls: true }), false)).toBe('compact');
  });

  it('prefers tri-state when both legacy and new fields are present', () => {
    const c = cfg({ showToolCalls: false, toolCallDisplay: 'compact' });
    expect(getToolCallDisplay(c, false)).toBe('compact');
  });

  it('getShowToolCalls returns false only when the resolved mode is hide', () => {
    expect(getShowToolCalls(cfg({ toolCallDisplay: 'full' }))).toBe(true);
    expect(getShowToolCalls(cfg({ toolCallDisplay: 'compact' }))).toBe(true);
    expect(getShowToolCalls(cfg({ toolCallDisplay: 'hide' }))).toBe(false);
    expect(getShowToolCalls(cfg({ showToolCalls: false }))).toBe(false);
    expect(getShowToolCalls(cfg(undefined))).toBe(true);
  });
});
