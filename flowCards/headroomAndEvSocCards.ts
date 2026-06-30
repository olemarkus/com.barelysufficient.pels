import CapacityGuard from '../lib/power/capacityGuard';
import { withHeadroomCurrentOn } from '../lib/plan/planHeadroomSupport';
import type {
  StateOfChargeObservedProbe,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import type { HeadroomForDeviceDecision } from '../lib/plan/planHeadroomDevice';
import { normalizeError } from '../lib/utils/errorUtils';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowNumberArg,
  readFlowRawArg,
} from './flowArgParsers';
import { requestPlanRebuildFromFlow } from './flowCardShared';
import type { FlowCardDeps } from './registerFlowCards';

const EV_SOC_CARD_ID = 'report_evcharger_battery_level';

export function registerHeadroomForDeviceCard(deps: FlowCardDeps): void {
  const hasHeadroomForDeviceCond = deps.homey.flow.getConditionCard('has_headroom_for_device');
  hasHeadroomForDeviceCond.registerRunListener(async (args: unknown) => (
    checkHeadroomForDevice({
      deviceId: readFlowDeviceArg(args),
      requiredKw: readFlowNumberArg(args, 'required_kw'),
    }, deps)
  ));
  hasHeadroomForDeviceCond.registerArgumentAutocompleteListener('device', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(
      snapshot.filter((d) => d.controllable !== false && (!d.loadKw || d.loadKw <= 0)),
      query,
    );
  });
}

async function checkHeadroomForDevice(
  args: { deviceId: string; requiredKw: number | null },
  deps: FlowCardDeps,
): Promise<boolean> {
  const capacityGuard = deps.getCapacityGuard();
  if (!capacityGuard) return false;
  const { deviceId, requiredKw } = args;
  if (!deviceId || requiredKw === null || requiredKw < 0) return false;

  const headroom = deps.getHeadroom();
  if (headroom === null) return false;

  const snapshot = await deps.getSnapshot();
  const deviceSnap = snapshot.find((d) => d.id === deviceId);
  if (!deviceSnap) return false;

  const decision = deps.evaluateHeadroomForDevice({
    // Stamp the whole array, not just the target: the activation in/active reads
    // run over every element and need each one's producer-resolved `currentOn`.
    devices: snapshot.map(withHeadroomCurrentOn),
    deviceId,
    device: withHeadroomCurrentOn(deviceSnap),
    headroom,
    requiredKw,
    cleanupMissingDevices: true,
  });
  if (!decision) return false;
  if (decision.stateChanged) {
    requestPlanRebuildFromFlow(deps, 'flow_headroom_cooldown');
  }
  logHeadroomCheck({
    deps,
    capacityGuard,
    deviceSnap,
    deviceId,
    requiredKw,
    decision,
  });

  return decision.allowed;
}

function logHeadroomCheck(params: {
  deps: FlowCardDeps;
  capacityGuard: CapacityGuard;
  deviceSnap: TargetDeviceSnapshot | undefined;
  deviceId: string;
  requiredKw: number;
  decision: HeadroomForDeviceDecision;
}): void {
  const {
    deps,
    capacityGuard,
    deviceSnap,
    deviceId,
    requiredKw,
    decision,
  } = params;
  deps.debugStructured({
    event: 'headroom_for_device_checked',
    deviceId,
    deviceName: deviceSnap?.name,
    softLimitKw: capacityGuard.getSoftLimit(),
    currentPowerKw: capacityGuard.getLastTotalPower() ?? null,
    deviceConsumptionKw: decision.observedKw,
    expectedPowerKw: deviceSnap?.expectedPowerKw ?? null,
    expectedPowerSource: deviceSnap?.expectedPowerSource ?? null,
    requiredKw,
    effectiveRequiredKw: decision.requiredKwWithPenalty,
    headroomForDeviceKw: decision.calculatedHeadroomForDeviceKw,
    cooldownSource: decision.cooldownSource ?? null,
    cooldownRemainingSec: decision.cooldownRemainingSec ?? null,
    penaltyLevel: decision.penaltyLevel,
    clearRemainingSec: decision.clearRemainingSec ?? null,
    allowed: decision.allowed,
  });
}

export function registerEvSocCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard(EV_SOC_CARD_ID);
  card.registerRunListener(async (args: unknown) => handleEvSocCardRun(deps, args));
  card.registerArgumentAutocompleteListener('device', async (query: string) => (
    getEvChargerDeviceOptions(deps, query)
  ));
}

async function handleEvSocCardRun(deps: FlowCardDeps, args: unknown): Promise<boolean> {
  const { chargerDeviceId, percent } = parseEvSocCardArgs(args);
  const charger = await requireEvChargerSnapshot(deps, chargerDeviceId);
  const observedAtMs = Date.now();
  const reportOutcome = deps.reportFlowBackedCapability({
    deviceId: chargerDeviceId,
    capabilityId: 'measure_battery',
    value: percent,
  });

  if (reportOutcome.refreshSnapshot) {
    await deps.refreshSnapshot({ emitFlowBackedRefresh: false });
  }
  if (reportOutcome.rebuildPlan) {
    requestPlanRebuildFromFlow(deps, EV_SOC_CARD_ID);
  }

  const updatedCharger = await getBestEffortEvChargerSnapshot(deps, chargerDeviceId);
  deps.getStructuredLogger('devices')?.info(buildEvSocLogPayload({
    charger,
    chargerDeviceId,
    updatedCharger,
    percent,
    observedAtMs,
  }));

  return true;
}

async function getBestEffortEvChargerSnapshot(
  deps: FlowCardDeps,
  chargerDeviceId: string,
): Promise<TargetDeviceSnapshot | undefined> {
  try {
    return await getDeviceSnapshotById(deps, chargerDeviceId);
  } catch (error: unknown) {
    const normalizedError = normalizeError(error);
    deps.debugStructured({
      event: 'ev_charger_snapshot_reload_failed',
      deviceId: chargerDeviceId,
      error: normalizedError.message,
    });
    return undefined;
  }
}

function parseEvSocCardArgs(args: unknown): {
  chargerDeviceId: string;
  percent: number;
} {
  const chargerDeviceId = readFlowDeviceArg(args);
  if (!chargerDeviceId) {
    throw new Error('Charger device must be provided.');
  }
  return {
    chargerDeviceId,
    percent: parseEvSocPercent(readFlowRawArg(args, 'battery_percent')),
  };
}

function buildEvSocLogPayload(params: {
  charger: TargetDeviceSnapshot;
  chargerDeviceId: string;
  updatedCharger: (TargetDeviceSnapshot & StateOfChargeObservedProbe) | undefined;
  percent: number;
  observedAtMs: number;
}) {
  const { charger, chargerDeviceId, updatedCharger, percent, observedAtMs } = params;
  return {
    event: 'ev_soc_reported',
    chargerDeviceId,
    chargerName: updatedCharger?.name ?? charger.name,
    percent,
    observedAtMs: updatedCharger?.stateOfCharge?.observedAtMs ?? observedAtMs,
    status: updatedCharger?.stateOfCharge?.status ?? 'unknown',
  };
}

async function getEvChargerDeviceOptions(
  deps: FlowCardDeps,
  query: string,
): Promise<Array<{ id: string; name: string }>> {
  const snapshot = await deps.getSnapshot();
  return buildDeviceAutocompleteOptions(
    snapshot.filter((device) => device.deviceClass === 'evcharger'),
    query,
  );
}

async function getDeviceSnapshotById(
  deps: FlowCardDeps,
  deviceId: string,
): Promise<TargetDeviceSnapshot | undefined> {
  const snapshot = await deps.getSnapshot();
  return snapshot.find((entry) => entry.id === deviceId);
}

async function requireEvChargerSnapshot(
  deps: FlowCardDeps,
  chargerDeviceId: string,
): Promise<TargetDeviceSnapshot> {
  const snapshot = await deps.getSnapshot();
  const charger = snapshot.find((entry) => entry.id === chargerDeviceId);
  if (!charger) {
    throw new Error(`Charger '${chargerDeviceId}' was not found in the snapshot.`);
  }
  if (charger.deviceClass !== 'evcharger') {
    throw new Error(`Device '${charger.name.trim()}' is not an EV charger.`);
  }
  return charger;
}

function parseEvSocPercent(rawValue: unknown): number {
  if (typeof rawValue === 'string' && rawValue.trim() === '') {
    throw new Error('Battery level must be a number between 0 and 100.');
  }
  const percent = typeof rawValue === 'number' ? rawValue : Number(rawValue);
  if (!Number.isFinite(percent)) {
    throw new Error('Battery level must be a number between 0 and 100.');
  }
  if (percent < 0 || percent > 100) {
    throw new Error('Battery level must be between 0 and 100.');
  }
  return Math.round(percent * 10) / 10;
}
