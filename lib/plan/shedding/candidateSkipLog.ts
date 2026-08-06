/**
 * Records WHY a controlled device did not become a shed candidate.
 *
 * Candidate gathering has a dozen exits that each drop a device with a bare
 * `continue` / `return null`. None of them left a trace, so a cycle that shed
 * nothing was indistinguishable from a cycle with nothing to shed. The
 * `hard_cap_shortfall_detected` record made that worse by reporting only
 * RESTORE-side holds (`blockedByCooldownDevices`, `blockedByPenaltyDevices`,
 * `blockedByInvariantDevices`) — all three read zero while a 2.9 kW water heater
 * sat unshed through a hard-cap breach on 2026-08-05 (`inc_26449fb9`), which
 * read as "nothing was in the way" when the truth was "the one device that
 * mattered was never a candidate".
 *
 * There is no counter anywhere for a shed-candidacy skip. This module is it.
 *
 * Deliberately a per-cycle ROLL-UP rather than one event per device: a home's
 * controlled-device count bounds the payload, a sustained overshoot rebuilds
 * every 10-30 s, and the `plan` debug topic is on in production. One line per
 * cycle carrying every skip is both quieter and easier to read than a dozen
 * scattered ones.
 *
 * Devices that are not controllable at all are out of scope rather than skipped,
 * and are not recorded — matching `controlledDevices` in the capacity summary,
 * which counts the same set.
 */
import type { StructuredDebugEmitter } from '../../logging/logger';

export type ShedCandidateSkipReason =
  | 'binary_confirmed_off'
  | 'control_not_writable'
  | 'zero_current_draw'
  | 'already_at_shed_temperature'
  | 'no_temperature_target'
  | 'stepped_measured_zero'
  | 'no_lower_step_reachable'
  | 'zero_step_relief'
  | 'budget_exempt_daily_only';

export type ShedCandidateSkipSummary = {
  skippedCandidateCount: number;
  skippedCandidateReasons: Array<{ reason: ShedCandidateSkipReason; count: number }>;
};

type SkippedDeviceRecord = {
  deviceId: string;
  deviceName?: string;
  reasonCode: ShedCandidateSkipReason;
  measuredPowerKw?: number;
  rungsTried?: string[];
};

export type ShedCandidateSkipRecorder = {
  record: (params: {
    device: { id: string; name?: string; measuredPowerKw?: number };
    reasonCode: ShedCandidateSkipReason;
    rungsTried?: string[];
  }) => void;
  summary: () => ShedCandidateSkipSummary;
  emit: () => void;
};

export function createShedCandidateSkipRecorder(
  debugStructured?: StructuredDebugEmitter,
): ShedCandidateSkipRecorder {
  const skipped: SkippedDeviceRecord[] = [];
  const counts = new Map<ShedCandidateSkipReason, number>();
  return {
    record: ({ device, reasonCode, rungsTried }) => {
      skipped.push({
        deviceId: device.id,
        ...(device.name !== undefined ? { deviceName: device.name } : {}),
        reasonCode,
        ...(device.measuredPowerKw !== undefined ? { measuredPowerKw: device.measuredPowerKw } : {}),
        ...(rungsTried ? { rungsTried } : {}),
      });
      counts.set(reasonCode, (counts.get(reasonCode) ?? 0) + 1);
    },
    summary: () => ({
      skippedCandidateCount: skipped.length,
      skippedCandidateReasons: [...counts.entries()].map(([reason, count]) => ({ reason, count })),
    }),
    emit: () => {
      if (!debugStructured || skipped.length === 0) return;
      debugStructured({
        event: 'plan_shed_candidates_skipped',
        skippedCandidateCount: skipped.length,
        skippedCandidateReasons: [...counts.entries()].map(([reason, count]) => ({ reason, count })),
        devices: skipped,
      });
    },
  };
}
