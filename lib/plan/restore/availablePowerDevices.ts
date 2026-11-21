import { resolveReadingMeasuredAfterMs } from '../../power/heldReading';
import { PLAN_REASON_CODES } from '../../../packages/shared-domain/src/planReasonSemantics';
import { isBinaryPlanDevice } from '../planBinaryDevice';
import { isMeteredPlanDevice } from '../planMeteredDevice';
import { spendLimitHeadroom } from '../planContext';
import { spendPhaseRoom } from '../phase/phaseRoom';
import type { DevicePlanDevice } from '../planTypes';
import { buildInsufficientHeadroomUpdate } from './accounting';
import { restoreHeadroomFor, type RestoreHeadroomAxes, type RestoreHeadroomLedger } from './headroomLedger';
import { setRestorePlanDevice } from './planDeviceUpdates';
import type { RestoreDeps } from './types';

type EnergizedDevice = {
  device: DevicePlanDevice;
  possibleDrawKw: number;
};

/** The aggregate meter can credit only draw it has had time to observe. */
export function drawIncludedInMeter(deps: RestoreDeps): (deviceId: string) => number | null {
  const coveredAtMs = resolveReadingMeasuredAfterMs(deps.powerTracker);
  return coveredAtMs === null
    ? () => null
    : (deviceId) => deps.drawEvidence.getMinimumLiveDrawSince(deviceId, coveredAtMs);
}

/**
 * An energized relay can start drawing behind the switch, before PELS gets
 * another sample. Debit the part its meter has not seen on the same admission
 * axes as a new start. An off decision does not release it until it reports off.
 */
export function accountForAvailablePowerDevices(
  devices: Map<string, DevicePlanDevice>,
  ledger: RestoreHeadroomLedger,
  drawAtMeter: (deviceId: string) => number | null,
): EnergizedDevice[] {
  const energized: EnergizedDevice[] = [];
  for (const device of devices.values()) {
    if (device.usesAvailablePower !== true || !isBinaryPlanDevice(device) || !isMeteredPlanDevice(device)) continue;
    if (!device.currentOn && !device.binaryCommandPending) continue;

    const possibleDrawKw = Math.max(device.expectedPowerKw, device.currentDrawKw);
    const measuredInRoomKw = Math.min(device.currentDrawKw, drawAtMeter(device.id) ?? 0);
    const unseenKw = possibleDrawKw - measuredInRoomKw;
    // The measured overload pass handles running draw. This relay stays on
    // only if the possible increase fits. Further starts must still cover its
    // full phase exposure because the phase reading is independent of the total.
    const room = ledger.availableFor(device);
    if (canYield(device) && room !== null && unseenKw > Math.max(0, room)) {
      setRestorePlanDevice(
        devices, device.id, buildInsufficientHeadroomUpdate(unseenKw, room, room - unseenKw, null, null, null),
      );
    }
    ledger.commit(device, unseenKw, possibleDrawKw);
    // eslint-disable-next-line functional/immutable-data -- The cycle owns this local list of energized devices.
    energized.push({ device, possibleDrawKw });
  }
  return energized;
}

/** Yield before a waiting ordinary load starts. The meter must see the
 * release in a later cycle before the ordinary load can spend any of it. */
export function yieldAvailablePower(
  devices: Map<string, DevicePlanDevice>,
  energized: readonly EnergizedDevice[],
  ledger: RestoreHeadroomLedger,
): void {
  if (energized.length === 0) return;
  const waiting = [...devices.values()].filter((device) => (
    device.usesAvailablePower !== true && device.reason.code === PLAN_REASON_CODES.insufficientHeadroom
  )).sort((a, b) => a.priority - b.priority);
  const donors = energized
    .filter(({ device }) => {
      const planned = devices.get(device.id);
      return planned !== undefined && canYield(planned);
    })
    .sort((a, b) => b.device.priority - a.device.priority);
  for (const target of waiting) {
    if (target.reason.code !== PLAN_REASON_CODES.insufficientHeadroom) continue;
    const { needKw } = target.reason;
    const room = ledger.availableFor(target);
    if (room === null || room >= needKw) continue;
    const releases = resolveReleases(donors, target, ledger.axes(), needKw);
    if (releases.length === 0) continue;
    for (const { device } of releases) {
      setRestorePlanDevice(devices, device.id, {
        plannedState: 'shed', reason: { code: PLAN_REASON_CODES.capacity },
      });
    }
    return;
  }
}

function resolveReleases(
  donors: readonly EnergizedDevice[],
  target: DevicePlanDevice,
  startingAxes: RestoreHeadroomAxes,
  needKw: number,
): EnergizedDevice[] {
  let axes = startingAxes;
  for (const [index, donor] of donors.entries()) {
    axes = afterRemoving(axes, donor);
    const room = restoreHeadroomFor(axes, target);
    if (room !== null && room >= needKw) return donors.slice(0, index + 1);
  }
  return [];
}

function afterRemoving(axes: RestoreHeadroomAxes, donor: EnergizedDevice): RestoreHeadroomAxes {
  const { device, possibleDrawKw } = donor;
  return {
    capacity: spendLimitHeadroom(axes.capacity, -possibleDrawKw),
    grid: spendLimitHeadroom(axes.grid, -possibleDrawKw),
    budget: device.budgetExempt ? axes.budget : spendLimitHeadroom(axes.budget, -possibleDrawKw),
    phase: spendPhaseRoom(axes.phase, device.phaseFootprint, -possibleDrawKw),
  };
}

const canYield = (device: DevicePlanDevice): boolean => (
  device.plannedState === 'keep' && device.control.commandAuthority && device.commandableNow !== false
);
