import {
  RESTORE_ADMISSION_RESERVE_KW,
} from './planConstants';

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

export function resolveRestoreDecisionPhase(rebuildReason: string | null | undefined): RestoreDecisionPhase {
  if (rebuildReason === 'initial' || rebuildReason === 'startup_snapshot_bootstrap') {
    return 'startup';
  }
  return 'runtime';
}
