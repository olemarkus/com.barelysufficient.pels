import { describe, expect, it, vi } from 'vitest';
import { acknowledgeRecommendation } from '../../lib/app/recommendationAcknowledgement';
import { SETUP_RECOMMENDATION_DISMISSALS } from '../../packages/shared-domain/src/settings/recommendationDismissals';
import { MockSettings } from '../mocks/homey';

const goals = 'after-setup:goals';
const cap = 'capacity:hard-cap-out-of-reach';

describe('recommendation acknowledgement', () => {
  it('keeps both choices when two sessions dismiss different cards from the same empty snapshot', () => {
    const settings = new MockSettings();
    expect(settings.getKeys()).not.toContain(SETUP_RECOMMENDATION_DISMISSALS);
    expect(acknowledgeRecommendation(settings, { id: goals, expectedVersion: null, version: 1 }))
      .toEqual({ [goals]: 1 });
    const second = { id: cap, expectedVersion: null, version: 10_000 };
    expect(acknowledgeRecommendation(settings, second)).toEqual({ [goals]: 1, [cap]: 10_000 });
    const write = vi.spyOn(settings, 'set');
    expect(acknowledgeRecommendation(settings, second)).toEqual(settings.get(SETUP_RECOMMENDATION_DISMISSALS));
    expect(write).not.toHaveBeenCalled();
  });

  it('retains a newer acknowledgement when an old session dismisses or restores the same card', () => {
    const settings = new MockSettings();
    settings.set(SETUP_RECOMMENDATION_DISMISSALS, { [goals]: 1, [cap]: 15_000 });
    const lowered = { [goals]: 1, [cap]: 8_000 };
    expect(acknowledgeRecommendation(settings, { id: cap, expectedVersion: 15_000, version: 8_000 }))
      .toEqual(lowered);
    const write = vi.spyOn(settings, 'set');
    expect(acknowledgeRecommendation(settings, { id: cap, expectedVersion: 15_000, version: null })).toEqual(lowered);
    expect(acknowledgeRecommendation(settings, { id: cap, expectedVersion: null, version: 15_000 })).toEqual(lowered);
    expect(write).not.toHaveBeenCalled();
    expect(settings.get(SETUP_RECOMMENDATION_DISMISSALS)).toEqual(lowered);
    expect(acknowledgeRecommendation(settings, { id: cap, expectedVersion: 8_000, version: null }))
      .toEqual({ [goals]: 1 });
    expect(settings.get(SETUP_RECOMMENDATION_DISMISSALS)).toEqual({ [goals]: 1 });
  });

  it.each([
    { stored: null }, { stored: undefined }, { stored: [] }, { stored: 'broken' },
  ])('preserves an unreadable existing setting ($stored)', ({ stored }) => {
    const settings = new MockSettings();
    settings.set(SETUP_RECOMMENDATION_DISMISSALS, stored);
    const write = vi.spyOn(settings, 'set');
    expect(() => acknowledgeRecommendation(settings, { id: goals, expectedVersion: null, version: 1 }))
      .toThrow('Saved recommendations could not be read.');
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { id: '', version: 1, expectedVersion: null },
    { id: goals, version: 0, expectedVersion: null },
    { id: goals, version: null },
  ])('rejects a malformed command before changing the setting', (body) => {
    const settings = new MockSettings();
    expect(() => acknowledgeRecommendation(settings, body)).toThrow('Invalid recommendation acknowledgement.');
    expect(settings.getKeys()).toEqual([]);
  });
});
