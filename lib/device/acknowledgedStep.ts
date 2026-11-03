import type {
  AcknowledgedStepObservation, TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import { resolveTargetPowerPresetPhaseCount } from '../../packages/shared-domain/src/targetPowerStepping';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from './managerControl';
import { resolveEvTargetPowerExactStep } from './targetPowerReachability';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';

/**
 * The exact EV step an acknowledged current names, or none when the preset has
 * no phase count or the current lies outside its range. Only an exact step: an
 * acknowledgement answers the command that named that step, so it is never
 * rounded onto a neighbouring rung.
 */
export function resolveAcknowledgedCurrentStepId(
  config: TargetPowerSteppedLoadConfig | undefined,
  currentA: unknown,
): string | undefined {
  const phaseCount = resolveTargetPowerPresetPhaseCount(config?.preset);
  if (!phaseCount || typeof currentA !== 'number' || !Number.isFinite(currentA) || currentA < 0) return undefined;
  return resolveEvTargetPowerExactStep(config, Math.round(currentA * 230 * phaseCount))?.id;
}

/** The acknowledged step a full read carries, dated by the integration's own source timestamp. */
export function resolveAcknowledgedStepObservation(
  config: TargetPowerSteppedLoadConfig | undefined,
  acknowledged: DeviceCapabilityMap[string] | undefined,
): AcknowledgedStepObservation | undefined {
  const stepId = resolveAcknowledgedCurrentStepId(config, acknowledged?.value);
  const observedAtMs = toCapabilityTimestampMs(acknowledged?.lastUpdated);
  return stepId === undefined || observedAtMs === undefined ? undefined : { stepId, observedAtMs };
}

/**
 * Keep the newer acknowledgement across an older read. A realtime echo is
 * dated on arrival, a full read by the source timestamp, so a refresh fetched
 * before the echo must not bring the earlier setting back.
 */
/* eslint-disable functional/immutable-data -- In-place update of the snapshot being committed. */
export function preserveNewerAcknowledgedStep(
  previous: Pick<TransportDeviceSnapshot, 'acknowledgedStep'>,
  snapshot: Pick<TransportDeviceSnapshot, 'acknowledgedStep'>,
): void {
  const kept = previous.acknowledgedStep;
  if (!kept) return;
  const next = snapshot;
  if (next.acknowledgedStep && next.acknowledgedStep.observedAtMs >= kept.observedAtMs) return;
  next.acknowledgedStep = kept;
}
/* eslint-enable functional/immutable-data */
