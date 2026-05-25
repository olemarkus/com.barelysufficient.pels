// One-shot diagnostic for devices whose accepted profile samples persistently
// lack `crediblePowerW`. Without `crediblePowerW` the energy window cannot be
// closed (see `lib/objectives/energyAccumulator.ts`), so `kwhPerUnit` stays
// `undefined`, the band buffer never grows (`resolveBandedUpdate` skips it),
// and adaptive learning silently stalls. Surface it once per device so the
// user knows which thermostats need per-step `planningPowerW` configured.
//
// In-memory only per `feedback_homey_sdk_unreliable`: a transient SDK gap that
// drops `measuredPowerKw` should not have to fight persisted state on restart.
// The flag re-arms on next process start, which is the right cadence for
// "configuration is still missing".
import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from './types';

export const OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD = 20;

export type NoPowerSourceDiagnosticEmitter = (payload: Record<string, unknown>) => void;

type DeviceState = {
  unresolvedCount: number;
  emitted: boolean;
};

const deviceStates = new Map<string, DeviceState>();

// Tracks the sample's own `crediblePowerW`, not the just-closed window's
// `kwhPerUnit`. The sample's `crediblePowerW` becomes the *next* window's
// left-edge power, so a single valid sample after a long silent run is the
// first one that lets training resume going forward — exactly when the counter
// should reset. The closed window still bills at the silent baseline and would
// keep `kwhPerUnit` undefined, so tracking it would never reset.
//
// The one-shot semantic prevents spam: once the user has been told a device
// has no power source, repeating it adds nothing. A flipping device only fires
// the diagnostic once per process lifetime; restarts re-arm.
export function emitObjectiveProfileNoPowerSourceIfNeeded(params: {
  deviceId?: string;
  deviceName?: string;
  profileKind: DeviceObjectiveProfile['kind'];
  acceptedSamples: number;
  sample: DeviceObjectiveProfileSample;
  debugStructured?: NoPowerSourceDiagnosticEmitter;
}): void {
  const {
    deviceId,
    deviceName,
    profileKind,
    acceptedSamples,
    sample,
    debugStructured,
  } = params;
  if (!debugStructured || !deviceId) return;
  const hasCrediblePower = typeof sample.crediblePowerW === 'number'
    && Number.isFinite(sample.crediblePowerW)
    && sample.crediblePowerW > 0;
  const { shouldEmit, unresolvedCount } = trackObjectiveProfileEnergyResolution({
    deviceId,
    hasCrediblePower,
  });
  if (!shouldEmit) return;
  debugStructured({
    event: 'objective_profile_no_power_source',
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    profileKind,
    acceptedSamples,
    consecutiveSamplesWithoutPower: unresolvedCount,
    threshold: OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD,
  });
}

function trackObjectiveProfileEnergyResolution(params: {
  deviceId: string;
  hasCrediblePower: boolean;
}): { shouldEmit: boolean; unresolvedCount: number } {
  const { deviceId, hasCrediblePower } = params;
  const previous = deviceStates.get(deviceId) ?? { unresolvedCount: 0, emitted: false };
  if (hasCrediblePower) {
    // Reset the counter on any valid power reading so a device that recovers
    // mid-window isn't accused of being silent. The `emitted` flag stays set:
    // the user has been notified once for this process lifetime; spamming the
    // same diagnostic adds nothing.
    if (previous.unresolvedCount === 0 && !previous.emitted) {
      deviceStates.delete(deviceId);
    } else {
      deviceStates.set(deviceId, { unresolvedCount: 0, emitted: previous.emitted });
    }
    return { shouldEmit: false, unresolvedCount: 0 };
  }
  const unresolvedCount = previous.unresolvedCount + 1;
  const shouldEmit = !previous.emitted
    && unresolvedCount >= OBJECTIVE_PROFILE_NO_POWER_SOURCE_THRESHOLD;
  deviceStates.set(deviceId, {
    unresolvedCount,
    emitted: previous.emitted || shouldEmit,
  });
  return { shouldEmit, unresolvedCount };
}

export function resetNoPowerSourceDiagnosticForTests(): void {
  deviceStates.clear();
}
