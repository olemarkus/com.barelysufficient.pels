import { describe, expect, it } from 'vitest';
import { planNeedsLiveUpdates, resolveDisplayPlanDeviceSnapshot } from '../src/ui/planLiveData.ts';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const countdownDevice = (endsAtMs: number) => {
  const device = uiDeviceFixture({ id: 'heater', currentState: 'off', plannedState: 'shed' }, false, 0);
  return { ...device, status: { ...device.status, reason: {
    text: 'Waiting after limiting a device (60s)',
    countdown: { kind: 'in_text' as const, endsAtMs, totalSec: 60,
      prefix: 'Waiting after limiting a device (', suffix: ')' },
  } } };
};

describe('resolveDisplayPlanDeviceSnapshot', () => {
  it('interpolates a running countdown from its end', () => {
    expect(resolveDisplayPlanDeviceSnapshot(countdownDevice(60_000), 15_200).status.reason?.text)
      .toBe('Waiting after limiting a device (45s)');
  });

  it('shows no reason once the countdown has expired instead of a line stuck at 0s', () => {
    const device = countdownDevice(60_000);
    expect(resolveDisplayPlanDeviceSnapshot(device, 60_000).status.reason).toBeNull();
    expect(planNeedsLiveUpdates({ devices: [device] }, 60_000)).toBe(false);
  });

  it('keeps the text of a countdown shown beside it, whose ring the card animates', () => {
    const device = uiDeviceFixture({ id: 'heater', currentState: 'on', plannedState: 'shed' }, false, 0);
    const ringed = { ...device, status: { ...device.status, reason: {
      text: 'Still drawing 1.2 kW after it was limited',
      countdown: { kind: 'beside_text' as const, endsAtMs: 60_000, totalSec: 60 },
    } } };
    expect(resolveDisplayPlanDeviceSnapshot(ringed, 15_000).status.reason?.text)
      .toBe('Still drawing 1.2 kW after it was limited');
    expect(planNeedsLiveUpdates({ devices: [ringed] }, 15_000)).toBe(true);
  });
});
