import type { DeviceOverviewSnapshot } from '../../../shared-domain/src/deviceOverview.ts';
import type { DeviceStatus } from '../../../contracts/src/deviceStatus.ts';
import type { SettingsUiPlanDeviceSnapshot } from '../../../contracts/src/settingsUiApi.ts';
import { buildDeviceStatus } from '../../../../lib/plan/deviceStatusReadModel.ts';
import { fixtureDeviceReason } from './fixtureDeviceReason.ts';

/** Test-only adapter for scenarios formerly described in terms of runtime axes. */
export type CardFixture = Partial<DeviceOverviewSnapshot> & Partial<SettingsUiPlanDeviceSnapshot> & {
  stateKind?: DeviceStatus['kind'];
  stateTone?: DeviceStatus['tone'];
  starvation?: SettingsUiPlanDeviceSnapshot['starvation'];
  surplusAbsorbActive?: boolean;
  carChargingState?: DeviceOverviewSnapshot['evChargingState'];
  idleClassification?: 'near_target_idle' | 'unresponsive' | 'capped_idle';
};

export function uiDeviceFixture(raw: Record<string, unknown> | CardFixture = {}, dryRun = false,
  anchorMs = Date.now()): SettingsUiPlanDeviceSnapshot {
  const device = raw as CardFixture;
  const reason = typeof device.reason === 'string' ? fixtureDeviceReason(device.reason)
    : device.reason ?? { code: 'keep', detail: null };
  const available = device.available ?? device.stateKind !== 'unavailable';
  const physicalState = device.currentState === 'off' ? 'off'
    : device.currentState === 'not_applicable' ? 'not_applicable' : 'on';
  // Producer-resolved identity, required on the overview snapshot so absence
  // cannot read as "no". A fixture that says nothing has no commandable binary
  // axis and is not a charger, which is what the optional fields used to mean.
  const isEvCharger = device.isEvCharger ?? false;
  const status = device.status ?? buildDeviceStatus({
    ...device, reason, controllable: device.controllable ?? true, available,
    binaryControllable: device.binaryControllable ?? false, isEvCharger,
    expectedPowerKw: device.expectedPowerKw ?? 0,
    currentState: physicalState,
    execution: {
      available, physicalState,
      observedStepId: device.steppedLoad?.reportedStepId ?? null,
      desiredBinary: device.plannedState === 'keep' && physicalState !== 'not_applicable' ? 'on' : null,
      desiredStepId: device.steppedLoad?.targetStepId ?? null,
      binaryProgress: device.binaryCommandPending ? 'pending' : 'settled',
      stepProgress: device.steppedLoad?.commandPending ? 'pending' : 'settled',
      targetProgress: device.pendingTargetCommand ? 'pending' : 'settled',
      resumeExpected: physicalState === 'off' && device.plannedState === 'keep',
      steppedTransitionPending: device.steppedLoad !== undefined
        && (device.binaryCommandPending === true || device.steppedLoad.commandPending),
      externalOffHeld: false,
    },
  }, dryRun, anchorMs);
  return {
    id: device.id ?? 'device', name: device.name ?? 'Device',
    controllable: device.controllable ?? true, available, status,
    isEvCharger,
    currentDrawKw: device.currentDrawKw, stateOfCharge: device.stateOfCharge,
    budgetExempt: device.budgetExempt, boostActive: device.boostActive ?? false,
    starvation: device.starvation,
  };
}
