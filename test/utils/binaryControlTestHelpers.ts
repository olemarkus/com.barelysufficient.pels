import { decideBinaryControl } from '../../lib/plan/planBinaryControl';
import {
  type BinaryControlTransport,
  dispatchBinaryControlDecision,
} from '../../lib/executor/binaryControlDispatch';
import type {
  BinaryControlActuationMode,
  BinaryControlLogContext,
  BinaryControlRestoreSource,
} from '../../lib/plan/planBinaryControlHelpers';
import type { DeviceObservation } from '../../lib/device/deviceObservation';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';

/**
 * Test helper that wires the post-split decide + dispatch flow against
 * legacy-shape mocks. The runtime split lives on the production seam
 * (`decideBinaryControl` + `dispatchBinaryControlDecision`); this helper
 * keeps the end-to-end test scaffolding readable.
 *
 * Accepts the same `deviceManager` mock the production code consumed
 * before the split (a structural type with `setCapability` and a
 * `DeviceObservation` view) and an optional flow trigger. The cycle is
 * identical to the previous `setBinaryControl`: plan decides, executor
 * records pending + dispatches and logs success/failure. The
 * observer-owned `pendingBinaryCommandStore` is sourced from the
 * provided `state.pendingBinaryCommands` field (PR #4 of the
 * observer/transport split) so callers that pre-seed pending state
 * still see it after dispatch.
 */
export async function runBinaryControlCycle(params: {
  state: PlanEngineState;
  deviceManager: DeviceObservation & {
    setCapability: (deviceId: string, capabilityId: string, value: boolean) => Promise<unknown>;
  };
  triggerFlowBackedBinaryControlRequest?: BinaryControlTransport['triggerFlowBackedBinaryControlRequest'];
  deviceId: string;
  name: string;
  desired: boolean;
  snapshot?: TargetDeviceSnapshot;
  logContext: BinaryControlLogContext;
  restoreSource?: BinaryControlRestoreSource;
  reason?: string;
  actuationMode?: BinaryControlActuationMode;
}): Promise<boolean> {
  const {
    state, deviceManager, triggerFlowBackedBinaryControlRequest,
    deviceId, name, desired, snapshot, logContext, restoreSource, reason, actuationMode,
  } = params;
  const pendingBinaryCommandStore = createPendingBinaryCommandStore(state.pendingBinaryCommands);
  const decision = decideBinaryControl({
    pendingBinaryCommandStore,
    deviceObservation: deviceManager,
    deviceId,
    name,
    desired,
    snapshot,
    logContext,
    restoreSource,
    reason,
    actuationMode,
  });
  if (!decision) return false;
  const transport: BinaryControlTransport = {
    observation: deviceManager,
    pendingBinaryCommandStore,
    setCapability: (id, cap, value) => deviceManager.setCapability(id, cap, value),
    triggerFlowBackedBinaryControlRequest,
  };
  const result = await dispatchBinaryControlDecision({
    decision,
    transport,
    snapshot,
  });
  return result.ok;
}
