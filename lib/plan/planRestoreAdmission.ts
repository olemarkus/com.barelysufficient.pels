import {
  RESTORE_ADMISSION_INFO_MARGIN_KW,
  RESTORE_ADMISSION_RESERVE_KW,
  RESTORE_STABLE_RESET_MS,
} from './planConstants';
import type { RestorePowerSource } from './planRestoreSwap';

export type RestoreAdmissionMetrics = {
  admissionReserveKw: number;
  marginKw: number;
  postReserveMarginKw: number;
  requiredKw: number;
};

export type RestoreDecisionPhase = 'startup' | 'runtime';
export type RestoreAdmissionLogFields = Pick<RestoreAdmissionMetrics, 'marginKw' | 'postReserveMarginKw'> & {
  reserveKw: number;
};

export function buildRestoreAdmissionMetrics(params: {
  availableKw: number;
  neededKw: number;
}): RestoreAdmissionMetrics {
  const admissionReserveKw = RESTORE_ADMISSION_RESERVE_KW;
  const marginKw = params.availableKw - params.neededKw;
  return {
    admissionReserveKw,
    marginKw,
    postReserveMarginKw: marginKw - admissionReserveKw,
    requiredKw: params.neededKw + admissionReserveKw,
  };
}

export function buildRestoreAdmissionLogFields(
  admission: RestoreAdmissionMetrics,
): RestoreAdmissionLogFields {
  return {
    reserveKw: admission.admissionReserveKw,
    marginKw: admission.marginKw,
    postReserveMarginKw: admission.postReserveMarginKw,
  };
}

export function shouldLogRestoreAdmissionAtInfo(params: {
  restoreType: 'binary' | 'target' | 'stepped' | 'swap';
  marginKw: number;
  penaltyLevel: number;
  powerSource?: RestorePowerSource;
  recentInstabilityMs?: number | null;
  nowTs?: number;
}): boolean {
  if (params.restoreType === 'swap') return true;
  if (params.marginKw < RESTORE_ADMISSION_INFO_MARGIN_KW) return true;
  if (params.penaltyLevel > 0) return true;
  if (params.powerSource === 'expected' || params.powerSource === 'configured' || params.powerSource === 'fallback') {
    return true;
  }

  const nowTs = params.nowTs ?? Date.now();
  if (
    typeof params.recentInstabilityMs === 'number'
    && nowTs - params.recentInstabilityMs < RESTORE_STABLE_RESET_MS
  ) {
    return true;
  }

  return false;
}

export function resolveRestoreDecisionPhase(rebuildReason: string | null | undefined): RestoreDecisionPhase {
  if (rebuildReason === 'initial' || rebuildReason === 'startup_snapshot_bootstrap') {
    return 'startup';
  }
  return 'runtime';
}
