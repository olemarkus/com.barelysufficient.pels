import type { HomeMembershipPort } from '../../home/membership';
import type { SmartTaskHomeScope } from '../../../packages/contracts/src/smartTaskHomeScope';
import type { CreateSmartTaskCandidateDevicesRead } from '../../../packages/contracts/src/widgetHostApi';
import { selectMeteredSnapshots } from '../../ports/meteredSnapshots';
import { MAIN_HOME_ID } from '../../utils/settingsKeys';
import { type SmartTaskCandidateSource, withSmartTaskTemperatureIntent } from './smartTaskQuickTargetValues';

/**
 * Multi-home v1 scope predicate shared by EVERY smart-task surface: the app's
 * candidate list + create validation (`appSmartTaskApi.ts`), the device-scoped write op's
 * defence-in-depth gate (`buildDeferredObjectiveDeviceWriteDeps`), the
 * set-deadline flow-card autocompletes (`registerAppFlowCards`), and — negated
 * — the decoration controller's diagnostics honesty (`createPlanEngine`).
 *
 * Smart tasks are planned against the MAIN home's meter budget (hard cap,
 * daily-budget overlay, priority-ordered reservations), so a device in a
 * separate-meter sub-home is out of scope. This predicate deliberately answers
 * durable MEMBERSHIP only: provisional/global authority fences must not look
 * like relocation, because lifecycle consumers negate this result to diagnose
 * and disarm tasks that genuinely moved behind another meter.
 */
export const isDeviceInSmartTaskMainHome = (membership: HomeMembershipPort, deviceId: string): boolean => {
  // Unknown/provisional membership is NOT evidence of durable relocation.
  // Treat it as Main here so existing tasks remain intact; every new promise
  // and device write additionally requires `hasMainHomeSmartTaskAuthority`.
  if (
    !membership.isOwnershipReady()
    || membership.hasPendingOwnershipGeneration?.() !== false
  ) return true;
  return membership.getHomeIdForDevice(deviceId) === MAIN_HOME_ID;
};

/** Reason-bearing authority gate for candidate/preview/create/write surfaces. */
export const resolveDeviceSmartTaskHomeScope = (
  membership: HomeMembershipPort,
  deviceId: string,
): SmartTaskHomeScope => {
  // Readiness FIRST: the cached map may contain a fail-safe Main/sub-home
  // resolution built from constructor defaults after a first suspect store
  // read. It is not durable relocation evidence until both stores are proven.
  if (
    !membership.isOwnershipReady()
    || membership.hasPendingOwnershipGeneration?.() !== false
  ) return 'unavailable';
  // Resolve source authority before membership/global fencing: once the active
  // source set itself is authoritative, source identity is durable even when
  // that meter belongs to a sub-home or creates a Main-meter ownership
  // collision. An unavailable source read still wins and remains retryable.
  const meterSources = membership.getConfiguredMeterSources();
  if (meterSources.state === 'unavailable') return 'unavailable';
  if (meterSources.deviceIds.has(deviceId)) return 'source_device';
  if (membership.getHomeIdForDevice(deviceId) !== MAIN_HOME_ID) return 'sub_home';
  if (membership.isMainHomeActuationFenced()) return 'unavailable';
  return 'main';
};

/**
 * The devices a new smart task can be created on: Main-home members that are
 * not a configured meter source, that the planner plans, with a live power
 * reading to count progress from. Each temperature device carries the owner's
 * setpoint (`readModeTargetC`: the governing mode's target, `null` when the
 * mode holds none). Unavailable while Main actuation is fenced or the
 * meter-source read is, since neither can say which devices a new promise may
 * target.
 */
export const readCreateSmartTaskCandidates = <T extends SmartTaskCandidateSource>(
  membership: HomeMembershipPort,
  devices: readonly T[],
  readModeTargetC: (deviceId: string) => number | null,
): CreateSmartTaskCandidateDevicesRead => {
  if (membership.isMainHomeActuationFenced()) return { state: 'unavailable' };
  const meterSources = membership.getConfiguredMeterSources();
  if (meterSources.state === 'unavailable') return { state: 'unavailable' };
  return {
    state: 'ready',
    devices: selectMeteredSnapshots(devices)
      // The planner plans managed devices only (`isRuntimePlannedDevice` in setup).
      .filter((device) => device.managed)
      .filter((device) => isDeviceInSmartTaskMainHome(membership, device.id))
      .filter((device) => !meterSources.deviceIds.has(device.id))
      .map((device) => withSmartTaskTemperatureIntent(device, readModeTargetC)),
  };
};
