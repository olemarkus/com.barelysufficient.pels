/*
 * Startup probe for the native-wiring flow-conflict initiative.
 *
 * Reads the owner's configured Homey Flows once and structured-logs:
 *   - PR1: how many device-capability writes exist across all Flows.
 *   - PR3 (this): for each native stepped-load device PELS controls, whether a
 *     user Flow writes a capability PELS would own — the per-device conflict
 *     verdict that the follow-up PR will use to gate native-wiring auto-enable.
 *
 * Telemetry only — it does not change any device, setting, or plan. Its job is
 * to prove the conflict-detection pipeline produces correct verdicts on real
 * Homeys before any default is flipped.
 *
 * Best-effort by design: the read fails closed (see readUserFlows) and the
 * caller invokes this fire-and-forget so a slow or failing Web API never
 * blocks or fails app startup. Candidate enumeration reads whatever device
 * snapshot exists at call time; if the snapshot has not warmed up yet the
 * logged `candidateCount` simply reflects that (the follow-up PR that acts on
 * the verdict runs it once the snapshot is ready).
 */
import type { Logger as PinoLogger } from 'pino';
import { readFlowCapabilityWrites, type FlowApiGet } from '../lib/flowApi/readUserFlows';
import { classifyFlowConflicts } from '../lib/flowApi/flowConflict';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';

/**
 * Stepped-load candidate devices, with the capabilities PELS would natively
 * write — the candidate set the conflict classifier runs against.
 *
 * Reads the producer-resolved `nativeWriteCapabilities` (set on the snapshot
 * from the device's pre-strip capabilities) rather than re-deriving from
 * `capabilities`: the snapshot's `capabilities` has the native control caps
 * stripped, and `nativeWriteCapabilities` is populated for stepped candidates
 * even when native wiring is off — so devices the conflict gate exists for are
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

export async function runFlowConflictProbe(deps: {
  get: FlowApiGet;
  getSnapshot: () => readonly TargetDeviceSnapshot[];
  structuredLog?: PinoLogger;
}): Promise<void> {
  const result = await readFlowCapabilityWrites({ get: deps.get });

  if (result.status === 'unknown') {
    deps.structuredLog?.info({
      event: 'flow_conflict_probe',
      outcome: 'unknown',
      reason: result.reason,
    });
    return;
  }

  let writeCount = 0;
  for (const capabilities of result.writes.values()) {
    writeCount += capabilities.size;
  }

  const candidates = resolveStepCandidates(deps.getSnapshot());
  const conflicts = classifyFlowConflicts(result.writes, candidates);

  deps.structuredLog?.info({
    event: 'flow_conflict_probe',
    outcome: 'ok',
    deviceCount: result.writes.size,
    writeCount,
    candidateCount: candidates.length,
    conflictCount: conflicts.length,
    conflicts: conflicts.map((conflict) => ({
      deviceId: conflict.deviceId,
      capabilities: conflict.conflictingCapabilities,
    })),
  });
}
