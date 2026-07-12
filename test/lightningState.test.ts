import { afterEach, describe, expect, it, vi } from 'vitest';

import { LightningState } from '../src/lightningState.js';

describe('LightningState', () => {
  afterEach(() => vi.useRealTimers());

  it('pulses strike state and retains storm state for the clear period', () => {
    vi.useFakeTimers();
    const state = new LightningState(30_000, 30 * 60_000);

    state.recordStrike(12.5, new Date('2026-07-12T12:00:00Z'));
    expect(state.current()).toMatchObject({
      strikeActive: true,
      stormActive: true,
      lastDistanceKm: 12.5,
    });

    vi.advanceTimersByTime(30_000);
    expect(state.current().strikeActive).toBe(false);
    expect(state.current().stormActive).toBe(true);

    vi.advanceTimersByTime(29.5 * 60_000);
    expect(state.current().stormActive).toBe(false);
  });

  it('extends the storm window after another strike', () => {
    vi.useFakeTimers();
    const state = new LightningState(10_000, 60_000);
    state.recordStrike(20);
    vi.advanceTimersByTime(50_000);
    state.recordStrike(10);
    vi.advanceTimersByTime(20_000);
    expect(state.current().stormActive).toBe(true);
    vi.advanceTimersByTime(40_000);
    expect(state.current().stormActive).toBe(false);
  });
});
