import { emitDeviceOverviewTransitions } from '../../lib/plan/planOverviewEmit';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { buildPlanDevice } from '../utils/planTestUtils';

// The overview LOG seam builds its own overview shape from the plan device
// (`planOverviewEmit.recordOverviewChange`), separately from the settings read
// model. Both must emit the ATOMIC temperature facet: the shared-domain
// classifier reads the trio as one object, so a seam that forgets to build it
// sees no temperature at all — and a satisfied target-only thermostat gets
// logged `active` while its card reads `Idle`. That divergence is the exact
// shape of the 2026-08-01 prod incident this classification exists to prevent,
// which is why it is pinned at the seam and not only in shared-domain.
describe('planOverviewEmit — temperature facet at the log seam', () => {
  const satisfiedTargetOnlyPlan = (): DevicePlan => ({
    meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
    devices: [
      buildPlanDevice({
        id: 'thermostat',
        name: 'Hall Thermostat',
        deviceType: 'temperature',
        // Target-only: no on/off axis, so the state word is pure inference from
        // the temperature pair + draw.
        binaryControllable: false,
        currentState: 'not_applicable',
        plannedState: 'keep',
        // Room ABOVE target, drawing nothing: nothing left to do.
        currentTemperature: 20.8,
        currentTarget: 16,
        plannedTarget: 16,
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      }),
    ],
  });

  it('classifies a satisfied target-only device as idle (the facet reaches the classifier)', () => {
    const captured: { deviceId: string; entry: Record<string, unknown> }[] = [];
    const changed = emitDeviceOverviewTransitions(
      satisfiedTargetOnlyPlan(),
      new Map(),
      {
        deviceOverviewLogRecorder: {
          record: (deviceId: string, entry: Record<string, unknown>) => {
            captured.push({ deviceId, entry });
          },
        } as never,
        getObservationStale: () => false,
      } as never,
    );

    expect(changed).toBe(true);
    expect(captured).toHaveLength(1);
    // Not `active`: with the facet absent from the seam's shape the classifier
    // cannot see the satisfied pair and falls back to the running inference.
    expect(captured[0]?.entry.stateKind).toBe('idle');
  });
});
