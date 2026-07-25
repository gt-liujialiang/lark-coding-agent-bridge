import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('tracks the newest usage figures across usage events', () => {
    let state = reduce(initialState, { type: 'usage', inputTokens: 100, outputTokens: 20 });
    expect(state.usage).toEqual({ inputTokens: 100, outputTokens: 20 });

    // Live events grow the totals (newest cumulative snapshot).
    state = reduce(state, { type: 'usage', inputTokens: 100, outputTokens: 60 });
    expect(state.usage).toEqual({ inputTokens: 100, outputTokens: 60 });
  });

  it('preserves cost from the final usage even if a later event omits it', () => {
    let state = reduce(initialState, {
      type: 'usage',
      inputTokens: 150,
      outputTokens: 210,
      costUsd: 0.03,
    });
    // A stray later live event without cost must not wipe the recorded cost.
    state = reduce(state, { type: 'usage', inputTokens: 150, outputTokens: 210 });
    expect(state.usage?.costUsd).toBe(0.03);
  });

  it('leaves usage undefined until a usage event arrives', () => {
    expect(reduce(initialState, { type: 'text', delta: 'hi' }).usage).toBeUndefined();
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });
});
