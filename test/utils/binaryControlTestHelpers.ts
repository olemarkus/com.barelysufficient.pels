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

/**
 * Test helper that wires the post-split decide + dispatch flow against
 * legacy-shape mocks. The runtime split lives on the production seam
 * (`decideBinaryControl` + `dispatchBinaryControlDecision`); this helper
 * keeps the end-to-end test scaffolding readable.
 *
 * Accepts the same `deviceManager` mock the production code consumed
 * before the split (a structural type with `setCapability` and a
 * `DeviceObservation` view) and an optional flow trigger. The cycle is
 * identical to the previous `setBinaryControl`: plan records pending +
 * returns a decision, then executor dispatches and logs success/failure.
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
  const decision = decideBinaryControl({
    state,
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
    setCapability: (id, cap, value) => deviceManager.setCapability(id, cap, value),
    triggerFlowBackedBinaryControlRequest,
  };
  return dispatchBinaryControlDecision({
    decision,
    transport,
    state,
  });
}
