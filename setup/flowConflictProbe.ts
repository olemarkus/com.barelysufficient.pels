/*
 * Native-wiring flow-conflict detection (notes/native-wiring/).
 *
 * Reads the owner's configured Homey Flows once, classifies per-device
 * conflicts against what PELS would natively write, and returns the set of
 * Hoiax (max_power_*) devices that are safe to auto-enable native wiring for
 * (eligible candidates with no conflicting Flow). The caller applies that
 * decision; this module computes and structured-logs it.
 *
 * Fail-closed: on an unreadable flow list (`status: 'unknown'`) it returns no
 * auto-enable decisions, so a transient Web API failure never flips native
 * wiring on over a real conflict. target_power steppers are already
 * default-on and are intentionally not part of the auto-enable set; only the
 * Hoiax max_power_* population is gated here.
 *
 * Best-effort by design: the read fails closed (see readUserFlows) and the
 * caller invokes this fire-and-forget, so a slow or failing Web API never
 * blocks or fails app startup.
 */
import { readFlowCapabilityWrites, type FlowApiGet } from '../lib/flowApi/readUserFlows';
import { classifyFlowConflicts } from '../lib/flowApi/flowConflict';
import { NATIVE_STEPPED_LOAD_CAPABILITY_IDS } from '../lib/device/nativeSteppedLoadWiring';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

// Minimal sink for the probe's outcome line. Narrower than a full pino logger
// (the probe only emits `.info`), which lets the caller hand in a guarded sink
// that drops the line once the app is uninitializing — so a flow read that
// resolves after teardown does not log into a closing worker rpc.
export type FlowConflictLog = { info: (obj: Record<string, unknown>) => void };

export type NativeWiringFlowConflict = {
  deviceId: string;
  conflictingCapabilities: string[];
  // The single named Flow responsible for the conflict, when there is exactly
  // one; undefined otherwise (UI falls back to generic copy).
  flowName?: string;
};

export type NativeWiringConflictDetection =
  | { status: 'ok'; autoEnableDeviceIds: string[]; conflicts: NativeWiringFlowConflict[] }
  | { status: 'unknown' };

/**
 * Stepped-load candidate devices, with the capabilities PELS would natively
 * write — the candidate set the conflict classifier runs against. Reads the
 * producer-resolved `nativeWriteCapabilities` (the snapshot's `capabilities`
 * has the native control caps stripped); it is populated for candidates even
 * when native wiring is off, so devices the conflict gate exists for are
 * included regardless of activation state.
 */
function resolveStepCandidates(
  snapshot: readonly TargetDeviceSnapshot[],
): Array<{ deviceId: string; ownedCapabilities: readonly string[] }> {
  return snapshot.flatMap((device) => {
    const ownedCapabilities = device.nativeWriteCapabilities ?? [];
    if (ownedCapabilities.length === 0) return [];
    return [{ deviceId: device.id, ownedCapabilities }];
  });
}

/** A Hoiax candidate is one whose native-write set includes a max_power_* cap. */
function isHoiaxAutoEnableCandidate(ownedCapabilities: readonly string[]): boolean {
  return ownedCapabilities.some((capabilityId) => (
    (NATIVE_STEPPED_LOAD_CAPABILITY_IDS as readonly string[]).includes(capabilityId)
  ));
}

export async function detectNativeWiringConflicts(deps: {
  get: FlowApiGet;
  getSnapshot: () => readonly TargetDeviceSnapshot[];
  structuredLog?: FlowConflictLog;
}): Promise<NativeWiringConflictDetection> {
  const result = await readFlowCapabilityWrites({ get: deps.get });

  if (result.status === 'unknown') {
    deps.structuredLog?.info({
      event: 'flow_conflict_detection',
      outcome: 'unknown',
      reason: result.reason,
    });
    return { status: 'unknown' };
  }

  const candidates = resolveStepCandidates(deps.getSnapshot());
  // Scope conflicts AND auto-enable to the Hoiax/max_power_* population the
  // gate governs. target_power steppers are always default-on with their
  // toggle hidden, so surfacing a conflict for them would render a banner
  // claiming control was "left off" with a switch that does not exist.
  const gatedCandidates = candidates.filter(
    (candidate) => isHoiaxAutoEnableCandidate(candidate.ownedCapabilities),
  );
  const conflicts = classifyFlowConflicts(result.writes, gatedCandidates);
  const conflictedIds = new Set(conflicts.map((conflict) => conflict.deviceId));

  const autoEnableDeviceIds = gatedCandidates
    .filter((candidate) => !conflictedIds.has(candidate.deviceId))
    .map((candidate) => candidate.deviceId);

  deps.structuredLog?.info({
    event: 'flow_conflict_detection',
    outcome: 'ok',
    candidateCount: candidates.length,
    gatedCandidateCount: gatedCandidates.length,
    conflictCount: conflicts.length,
    autoEnableCount: autoEnableDeviceIds.length,
    conflicts: conflicts.map((conflict) => ({
      deviceId: conflict.deviceId,
      capabilities: conflict.conflictingCapabilities,
      flowName: conflict.flowName,
    })),
  });

  return {
    status: 'ok',
    autoEnableDeviceIds,
    conflicts: conflicts.map((conflict) => (
      conflict.flowName === undefined
        ? { deviceId: conflict.deviceId, conflictingCapabilities: conflict.conflictingCapabilities }
        : {
          deviceId: conflict.deviceId,
          conflictingCapabilities: conflict.conflictingCapabilities,
          flowName: conflict.flowName,
        }
    )),
  };
}
