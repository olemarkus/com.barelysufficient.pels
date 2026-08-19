import { emitDeviceOverviewTransitions } from '../../lib/plan/planOverviewEmit';
import { buildSettingsOverviewDeviceReadModel } from '../../lib/plan/settingsOverviewReadModel';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { buildPlanDevice, buildPlanMeta } from '../utils/planTestUtils';

// The overview log and live-card seams share one atomic temperature resolver.
// Pin that integration here: the shared-domain classifier reads the trio as one
// object, so a carrier that misses the observer overlay can disagree with the
// state the owner sees on the card.
describe('planOverviewEmit — temperature facet at the log seam', () => {
  const satisfiedTargetOnlyPlan = (): DevicePlan => ({
    meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
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
        getObservedTemperature: () => ({
          kind: 'observed',
          value: { currentTarget: 16, currentTemperature: 20.8 },
        }),
      } as never,
    );

    expect(changed).toBe(true);
    expect(captured).toHaveLength(1);
    // Not `active`: with the facet absent from the seam's shape the classifier
    // cannot see the satisfied pair and falls back to the running inference.
    expect(captured[0]?.entry.stateKind).toBe('idle');
  });

  it('uses the same fresher observer pair for the live card and activity log', () => {
    const plan = satisfiedTargetOnlyPlan();
    const staleDevice = plan.devices[0];
    if (!staleDevice) throw new Error('expected thermostat fixture');
    const updatedDevice = {
      ...staleDevice,
      currentTarget: 21,
      plannedTarget: 21,
      currentTemperature: 20.8,
    };
    const stalePlan = {
      ...plan,
      devices: [updatedDevice],
    } as DevicePlan;
    const deps = {
      getObservedTemperature: () => ({
        kind: 'observed' as const,
        value: { currentTarget: 21, currentTemperature: 21.1 },
      }),
      getObservationStale: () => false,
    };
    const captured: Record<string, unknown>[] = [];

    emitDeviceOverviewTransitions(stalePlan, new Map(), {
      ...deps,
      deviceOverviewLogRecorder: {
        record: (_deviceId: string, entry: Record<string, unknown>) => captured.push(entry),
      } as never,
    });

    expect(buildSettingsOverviewDeviceReadModel(updatedDevice, deps).stateKind).toBe('idle');
    expect(captured[0]?.stateKind).toBe('idle');
  });
});
