import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';

const waitingFor = (phaseFootprint: Record<string, unknown>) => uiDeviceFixture({
  id: 'heater', name: 'Heater', plannedState: 'shed', currentState: 'off',
  reason: { code: 'phase_limit', phase: 'L1' }, phaseFootprint,
} as never);

describe('card for a device waiting for room on a phase', () => {
  it('says what it needs and offers the phase setting while the phase is unknown', () => {
    const { status } = waitingFor({ kind: 'unknown' });
    expect(status.reason).toMatchObject({ text: 'Waiting for room on L1', offersPhaseSetting: true });
  });

  it('keeps the line without the link once the phase is known', () => {
    const { status } = waitingFor({ kind: 'single', phase: 'L1' });
    expect(status.reason?.text).toBe('Waiting for room on L1');
    expect(status.reason?.offersPhaseSetting).toBeUndefined();
  });
});
