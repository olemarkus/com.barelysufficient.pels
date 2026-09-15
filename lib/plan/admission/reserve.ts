import type { PlanRebuildTrigger } from '../planRebuildTrigger';

/**
 * What a restore admission decision is made of.
 *
 * One number: the slack against this device's own bar. That bar is not the bare
 * draw — `neededKw` already folds in the per-device restore buffer, the
 * recent-shed inflation and any activation penalty — so admitting at exactly
 * zero margin still leaves the buffer unspent. That is what makes `>= 0` the
 * right test rather than an off-by-one.
 *
 * There used to be two more. A flat `admissionReserveKw` was subtracted from
 * every candidate, and the gate then required the remainder to clear a second
 * flat floor, so every restore of every device carried 0.5 kW of slack forever
 * against the possibility that some restore somewhere might overshoot. Three
 * mechanisms already answer that possibility with evidence instead:
 * `computeRestoreBufferKw` scales a buffer to the device's own draw, the
 * recent-shed inflation raises the bar for five minutes after a shed so a device
 * cannot flap, and the activation-penalty ladder raises a device's own bar after
 * a measured overshoot it contributed to. The flat pair charged the devices that
 * never overshoot for the ones that do.
 *
 * The ladder's reach is narrower than it sounds and should not be oversold: it
 * attributes only to a device whose OWN draw rose between builds, inside a
 * two-minute attempt window, and only when the whole-home delta clears
 * `SOFT_OVERSHOOT_DEADBAND_KW`. A later background rise tipping the house over
 * with the restored device already at steady draw earns no rung.
 */
export type RestoreAdmissionMetrics = {
  marginKw: number;
};

export type RestoreDecisionPhase = 'startup' | 'runtime';
export type RestoreAdmissionLogFields = Pick<RestoreAdmissionMetrics, 'marginKw'>;

export function buildRestoreAdmissionMetrics(params: {
  availableKw: number;
  neededKw: number;
}): RestoreAdmissionMetrics {
  return { marginKw: params.availableKw - params.neededKw };
}

/** True when this device fits in the room available to it. */
export function isRestoreAdmitted(admission: RestoreAdmissionMetrics): boolean {
  return admission.marginKw >= 0;
}

export function buildRestoreAdmissionLogFields(
  admission: RestoreAdmissionMetrics,
): RestoreAdmissionLogFields {
  return { marginKw: admission.marginKw };
}

export function resolveRestoreDecisionPhase(
  rebuildTrigger: PlanRebuildTrigger | null | undefined,
): RestoreDecisionPhase {
  if (rebuildTrigger === 'initial' || rebuildTrigger === 'startup_snapshot_bootstrap') {
    return 'startup';
  }
  return 'runtime';
}
