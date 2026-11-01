import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { NewSmartTaskWriteResult } from '../../../packages/contracts/src/smartTaskEdit';
import type { WidgetObjectiveWriteResult } from '../../../packages/contracts/src/widgetHostApi';
import {
  createObjectiveForDevice,
  upsertObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
  type ObjectiveWriteOutcome,
} from './objectiveWrite';
import {
  validateSmartTaskWrite,
  type SmartTaskWriteDevice,
  type SmartTaskWriteReads,
} from './smartTaskWriteValidation';

// The app side of every smart-task request lane: validate the candidate, then
// persist it through the device-scoped write op the deadline Flow cards use.
// The request lanes (`smartTask*Lane.ts`) reach these through the app's
// `createDeferredObjective`, `createNewDeferredObjective` and
// `rescueDeviceWithBudgetExemption`; `setup/` binds the ports and forwards.

/**
 * What a smart-task write reads and writes through, bound by `setup/`: the
 * validation's owner reads, the write op's deps, and the app clock.
 */
export type SmartTaskWritePorts<Device extends SmartTaskWriteDevice> = {
  reads: SmartTaskWriteReads<Device>;
  /**
   * The device-scoped write op's deps, or `null` while startup has not wired
   * the plan recorders a new task's first plan is seeded through.
   */
  resolveWriteDeps(): DeferredObjectiveDeviceWriteDeps | null;
  nowMs: number;
};

type WriteRejectReason = Extract<WidgetObjectiveWriteResult, { ok: false }>['reason'];

/**
 * Map a refused device-scoped write onto the app's write reject union. The
 * write op's durable sub-home and source-device gates (defence in depth,
 * normally caught earlier by `validateSmartTaskWrite`) keep their typed
 * reasons; the transient refusals (an untrustworthy absence or home-scope
 * read) collapse to the retryable `write_refused`.
 */
export const mapObjectiveWriteRefusalReason = (
  reason: Extract<ObjectiveWriteOutcome, { persisted: false }>['reason'],
): Extract<WriteRejectReason, 'device_in_sub_home' | 'device_not_planned' | 'write_refused'> => (
  reason === 'device_in_sub_home' || reason === 'device_not_planned'
    ? reason
    : 'write_refused'
);

/**
 * Write the device's task, replacing an open one: the widget create, the
 * settings UI's edit, and the rescue. `rescuePolicy` `'preserve'` keeps a
 * standing permission set when the candidate names none; `'replace'` persists
 * exactly the candidate's set, for a request that states the complete set.
 *
 * A write before startup has wired the plan recorders answers `unavailable`, so
 * the surface offers a retry rather than calling a valid request bad.
 */
export const upsertSmartTask = <Device extends SmartTaskWriteDevice>(
  ports: SmartTaskWritePorts<Device>,
  deviceId: string,
  candidate: DeferredObjectivePlanPreviewCandidate,
  rescuePolicy: 'preserve' | 'replace',
): WidgetObjectiveWriteResult => {
  const validated = validateSmartTaskWrite(ports.reads, deviceId, candidate);
  if (!validated.ok) return validated;
  const deps = ports.resolveWriteDeps();
  if (!deps) return { ok: false, reason: 'unavailable' };
  // Per-device-key write: touches only this device's settings key, so it
  // cannot drop a sibling task. The write can still refuse on an
  // untrustworthy absence read; that surfaces as a retryable failure rather
  // than a false success.
  const outcome = upsertObjectiveForDevice(
    deps, deviceId, validated.device.name ?? null, validated.entry, rescuePolicy,
  );
  if (!outcome.persisted) return { ok: false, reason: mapObjectiveWriteRefusalReason(outcome.reason) };
  return { ok: true };
};

/**
 * The settings UI's create: a fresh task, never one written over an open task
 * (`createObjectiveForDevice` refuses against its own read of the previous
 * entry), with exactly the permissions the request names, since the create
 * form shows every one of them and its preview priced exactly those.
 */
export const createFreshSmartTask = <Device extends SmartTaskWriteDevice>(
  ports: SmartTaskWritePorts<Device>,
  deviceId: string,
  candidate: DeferredObjectivePlanPreviewCandidate,
): NewSmartTaskWriteResult => {
  const validated = validateSmartTaskWrite(ports.reads, deviceId, candidate);
  if (!validated.ok) return validated;
  const deps = ports.resolveWriteDeps();
  if (!deps) return { ok: false, reason: 'unavailable' };
  const outcome = createObjectiveForDevice(
    deps, deviceId, validated.device.name ?? null, validated.entry, 'replace',
  );
  if (outcome.persisted) return { ok: true };
  if (outcome.reason === 'open_task_exists') return { ok: false, reason: 'task_exists' };
  return { ok: false, reason: mapObjectiveWriteRefusalReason(outcome.reason) };
};
