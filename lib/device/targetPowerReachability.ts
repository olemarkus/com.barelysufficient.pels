import type {
  SteppedLoadProfile,
  SteppedLoadStep,
  TargetPowerReachabilityState,
  TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import { isWithinSteppedLoadPowerCeiling } from './steppedLoadPowerCeiling';

/** Runtime-only join of user configuration and learned device evidence. */
export type TargetPowerConfigWithReachability = TargetPowerSteppedLoadConfig & {
  reachability?: TargetPowerReachabilityState;
};

export type DeviceTargetPowerConfigsWithReachability = Record<string, TargetPowerConfigWithReachability>;

const NOMINAL_PHASE_VOLTAGE = 230;
const EV_CHARGER_AMPS = [6, 8, 10, 12, 14, 16, 20, 24, 28, 32] as const;
/** 5% covers mains up to 241.5 V. */
const EV_RUNG_OVER_NOMINAL_RATIO = 0.05;
/** The share of the gap to the rung above that the allowance never reaches. */
const EV_RUNG_OVER_NOMINAL_GAP_FRACTION = 0.5;

const isFiniteNonNegative = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

export const isEvTargetPowerConfig = (
  config: TargetPowerConfigWithReachability | undefined,
): config is TargetPowerConfigWithReachability & {
  preset: 'ev_charger_1_phase' | 'ev_charger_3_phase';
} => config?.enabled !== false
  && (config?.preset === 'ev_charger_1_phase' || config?.preset === 'ev_charger_3_phase');

const resolvePhaseCount = (config: TargetPowerSteppedLoadConfig): 1 | 3 => (
  config.preset === 'ev_charger_3_phase' ? 3 : 1
);

const resolveDefaultMaxPowerW = (config: TargetPowerSteppedLoadConfig): number => (
  32 * NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config)
);

const resolveCandidateMaxPowerW = (config: TargetPowerSteppedLoadConfig): number => {
  const physicalMaximum = typeof config.max === 'number' && Number.isFinite(config.max) && config.max > 0
    ? Math.round(config.max)
    : resolveDefaultMaxPowerW(config);
  return config.currentLimits
    ? Math.min(physicalMaximum, config.currentLimits.maxA * NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config))
    : physicalMaximum;
};

const resolveCandidateMinPowerW = (config: TargetPowerSteppedLoadConfig): number => (
  config.currentLimits
    ? config.currentLimits.minA * NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config)
    : Math.min(6 * NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config), resolveCandidateMaxPowerW(config))
);

const formatCurrentStepId = (currentA: number): string => {
  const rounded = Math.round(currentA * 1000) / 1000;
  return `${String(rounded)}a`;
};

const buildPowerStep = (
  config: TargetPowerSteppedLoadConfig,
  planningPowerW: number,
): SteppedLoadStep => {
  const wattsPerAmp = NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config);
  const planningCurrentA = planningPowerW / wattsPerAmp;
  return {
    id: formatCurrentStepId(planningCurrentA),
    planningPowerW,
    planningCurrentA,
  };
};

export const resolveEvTargetPowerExactStep = (
  config: TargetPowerSteppedLoadConfig | undefined,
  planningPowerW: number,
): SteppedLoadStep | undefined => {
  if (!isEvTargetPowerConfig(config) || !isFiniteNonNegative(planningPowerW)) return undefined;
  const roundedPowerW = Math.round(planningPowerW);
  if (roundedPowerW > resolveCandidateMaxPowerW(config)) return undefined;
  if (roundedPowerW === 0) return { id: 'off', planningPowerW: 0, planningCurrentA: 0 };
  if (roundedPowerW < resolveCandidateMinPowerW(config)) return undefined;
  return buildPowerStep(config, roundedPowerW);
};

/** Resolve the canonical EV current-labelled step id even without a watt token. */
export const resolveEvTargetPowerExactStepById = (
  config: TargetPowerSteppedLoadConfig | undefined,
  stepId: string,
): SteppedLoadStep | undefined => {
  if (!isEvTargetPowerConfig(config)) return undefined;
  const normalizedStepId = stepId.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)a$/u.exec(normalizedStepId);
  if (!match) return normalizedStepId === 'off'
    ? { id: 'off', planningPowerW: 0, planningCurrentA: 0 }
    : undefined;
  const currentA = Number(match[1]);
  if (!Number.isFinite(currentA)) return undefined;
  return resolveEvTargetPowerExactStep(
    config,
    currentA * NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config),
  );
};

const sortSteps = (steps: SteppedLoadStep[]): SteppedLoadStep[] => (
  [...steps].sort((left, right) => left.planningPowerW - right.planningPowerW || left.id.localeCompare(right.id))
);

const appendExactStep = (
  config: TargetPowerSteppedLoadConfig,
  steps: SteppedLoadStep[],
  planningPowerW: number,
): SteppedLoadStep[] => {
  if (planningPowerW <= 0 || steps.some((step) => step.planningPowerW === planningPowerW)) return steps;
  return sortSteps([...steps, buildPowerStep(config, planningPowerW)]);
};

/**
 * Candidate EV commands inside the authored operating range.
 *
 * A legacy watt maximum is a CEILING, not a rung. A cap between two rungs — a 25 A
 * supply limit, say — leaves 24 A as the highest step, because this ladder is
 * a set of currents an EV charger is known to offer and the cap is not one of
 * them: nothing has shown the charger has a step there. The cap still bounds
 * admission (`resolveEvTargetPowerExactStep`) — it just stops being somewhere
 * to stand.
 *
 * The rung watts are a nominal seed (`amps * 230 * phases`), not a measurement:
 * real draw at a rung is learned per `(deviceId, stepId)` by
 * `devicePowerCalibration.ts`, and commonly lands under nominal because the car
 * draws less than the charger offers (16 A commanded, 15 A taken). A cap
 * sitting tens of watts below a rung is therefore a units artefact — three-phase
 * chargers are sold as "11 kW" but the 16 A rung is 11040 W — and reclaiming it
 * with a tolerance would buy nominal precision the calibration layer overrides
 * anyway.
 *
 * ACCEPTED COST: an off-ladder maximum becomes unreachable by probing. That is
 * real for a native `target_power` charger, which is commanded in WATTS
 * (`resolveNativeSteppedLoadCommand`) and could have taken the exact cap; it is
 * moot for current-commanded transports, which only ever accept a whole amp.
 * The exact step is still restored the moment the device DEMONSTRATES it — see
 * the observed append in the confirmed profile, which is evidence rather than
 * invention.
 */
export const buildEvTargetPowerCandidateProfile = (
  config: TargetPowerSteppedLoadConfig,
): SteppedLoadProfile => {
  const phaseCount = resolvePhaseCount(config);
  const maxPowerW = resolveCandidateMaxPowerW(config);
  const minPowerW = resolveCandidateMinPowerW(config);
  // Explicit whole-amp bounds are usable commands, including between the
  // standard rungs. A legacy watt ceiling alone still does not prove a rung.
  const currents = config.currentLimits
    ? [...new Set([...EV_CHARGER_AMPS, config.currentLimits.minA, config.currentLimits.maxA])].sort((a, b) => a - b)
    : EV_CHARGER_AMPS;
  return {
    steps: [
      { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
      ...currents
        .map((amps) => ({
          id: `${amps}a`,
          planningPowerW: amps * NOMINAL_PHASE_VOLTAGE * phaseCount,
          planningCurrentA: amps,
        }))
        .filter((step) => step.planningPowerW >= minPowerW && step.planningPowerW <= maxPowerW),
    ],
  };
};

/**
 * The configured rung a measured EV draw is on, or `undefined` when the reading
 * is outside the ladder. A rung is a current, and a watt reading is that current
 * at whatever the mains and the car happen to be doing, so a measurement names a
 * rung and never creates one: only a value a charger or Flow states as a current
 * can be an exact step (`resolveEvTargetPowerExactStep`).
 *
 * A reading just under a rung is that rung (a car on 16 A reads about 3.6 kW).
 * Otherwise it is the rung at or below it, so a charger reading over nominal
 * stays on its rung and a reading between rungs never claims the one above, which
 * would prove a current the charger has not reached. Above the top rung only
 * mains drift is accepted.
 */
export const resolveEvMeasuredStep = (
  config: TargetPowerSteppedLoadConfig | undefined,
  measuredPowerW: number,
): SteppedLoadStep | undefined => {
  if (!isEvTargetPowerConfig(config) || !isFiniteNonNegative(measuredPowerW)) return undefined;
  const { steps } = buildEvTargetPowerCandidateProfile(config);
  const justUnder = steps.find((step) => (
    step.planningPowerW > 0 && isWithinSteppedLoadPowerCeiling(step.planningPowerW, measuredPowerW)
  ));
  if (justUnder) return justUnder;
  const below = steps.filter((step) => step.planningPowerW <= measuredPowerW).at(-1);
  if (!below || (below.planningPowerW === 0 && measuredPowerW > 0)) return undefined;
  const isTopRung = below === steps.at(-1);
  return isTopRung && measuredPowerW > below.planningPowerW * (1 + EV_RUNG_OVER_NOMINAL_RATIO) ? undefined : below;
};

export const buildEvTargetPowerProfileFingerprint = (
  config: TargetPowerSteppedLoadConfig,
): string => {
  const candidate = buildEvTargetPowerCandidateProfile(config);
  return `${config.preset ?? 'unknown'}:${candidate.steps
    .map((step) => `${step.id}=${Math.round(step.planningPowerW)}`)
    .join(',')}`;
};

/**
 * A maximum saved from a reading just over a rung reads as that rung: the proven
 * maximum only ever rises, so it would otherwise stay an off-ladder step. Saved
 * state does not record where a value came from, so this is bounded to mains
 * drift: under half the gap to the next rung and under one whole amp.
 */
const withSavedMaximumOnRung = (
  config: TargetPowerSteppedLoadConfig,
  state: TargetPowerReachabilityState,
): TargetPowerReachabilityState => {
  const { steps } = buildEvTargetPowerCandidateProfile(config);
  const rung = steps.filter((step) => step.planningPowerW < state.maxReachedPowerW).at(-1);
  if (!rung || rung.planningPowerW <= 0) return state;
  const above = steps[steps.indexOf(rung) + 1];
  const overW = state.maxReachedPowerW - rung.planningPowerW;
  const isMainsDrift = overW <= rung.planningPowerW * EV_RUNG_OVER_NOMINAL_RATIO
    && overW < NOMINAL_PHASE_VOLTAGE * resolvePhaseCount(config)
    && (!above || overW <= (above.planningPowerW - rung.planningPowerW) * EV_RUNG_OVER_NOMINAL_GAP_FRACTION);
  return isMainsDrift ? { ...state, maxReachedPowerW: rung.planningPowerW } : state;
};

export const resolveValidTargetPowerReachability = (
  config: TargetPowerConfigWithReachability | undefined,
): TargetPowerReachabilityState | undefined => {
  if (!isEvTargetPowerConfig(config)) return undefined;
  const state = config.reachability;
  if (state && config.currentLimits && state.profileFingerprint !== buildEvTargetPowerProfileFingerprint(config)) {
    const { currentLimits: _currentLimits, ...chargerConfig } = config;
    const chargerEvidence = resolveValidTargetPowerReachability(chargerConfig);
    return chargerEvidence && buildTargetPowerReachabilityState({
      config,
      maxReachedPowerW: Math.min(chargerEvidence.maxReachedPowerW, resolveCandidateMaxPowerW(config)),
      probeFailureCount: chargerEvidence.probeFailureCount,
      nextProbeAtMs: chargerEvidence.nextProbeAtMs,
    });
  }
  if (!state || state.profileFingerprint !== buildEvTargetPowerProfileFingerprint(config)) return undefined;
  if (!isFiniteNonNegative(state.maxReachedPowerW)) return undefined;
  if (state.maxReachedPowerW < resolveCandidateMinPowerW(config)) return undefined;
  if (state.maxReachedPowerW > resolveCandidateMaxPowerW(config)) return undefined;
  if (!Number.isInteger(state.probeFailureCount) || state.probeFailureCount < 0) return undefined;
  if (state.nextProbeAtMs !== undefined && !isFiniteNonNegative(state.nextProbeAtMs)) return undefined;
  return withSavedMaximumOnRung(config, state);
};

const resolveObservedPowerW = (
  config: TargetPowerSteppedLoadConfig,
  observedPowerW: number | undefined,
): number | undefined => {
  if (!isFiniteNonNegative(observedPowerW)) return undefined;
  const roundedPowerW = Math.round(observedPowerW);
  if (roundedPowerW < resolveCandidateMinPowerW(config)) return undefined;
  return roundedPowerW <= resolveCandidateMaxPowerW(config) ? roundedPowerW : undefined;
};

export const resolveEvTargetPowerConfirmedMaxPowerW = (
  config: TargetPowerConfigWithReachability,
  observedPowerW?: number,
): number => {
  const persisted = resolveValidTargetPowerReachability(config)?.maxReachedPowerW;
  const observed = resolveObservedPowerW(config, observedPowerW);
  return Math.max(
    persisted ?? resolveCandidateMinPowerW(config),
    observed ?? 0,
  );
};

/** Confirmed ladder used by device snapshots, emulation, and UI. */
export const resolveEvTargetPowerConfirmedProfile = (
  config: TargetPowerConfigWithReachability,
  observedPowerW?: number,
): SteppedLoadProfile => {
  const candidate = buildEvTargetPowerCandidateProfile(config);
  const confirmedMaxW = resolveEvTargetPowerConfirmedMaxPowerW(config, observedPowerW);
  const observed = resolveObservedPowerW(config, observedPowerW);
  let steps = candidate.steps.filter((step) => step.planningPowerW <= confirmedMaxW);
  if (observed !== undefined) steps = appendExactStep(config, steps, observed);
  return {
    steps: appendExactStep(config, steps, confirmedMaxW),
  };
};

/**
 * Producer-only planner view. A due probe is represented as one ordinary next
 * rung; no probe metadata crosses into planner code.
 */
export const resolveEvTargetPowerPlannerProfile = (params: {
  config: TargetPowerConfigWithReachability | undefined;
  confirmedProfile: SteppedLoadProfile;
  nowMs: number;
}): SteppedLoadProfile => {
  const { config, confirmedProfile, nowMs } = params;
  // The observation ladder retains device truth. Car policy narrows commands
  // only: Automatic current ladders carry their integration-resolved amps;
  // a Manual EV preset carries its configured nominal phase conversion.
  const planningProfile = config?.currentLimits ? {
    ...confirmedProfile,
    steps: confirmedProfile.steps.filter((step) => {
      if (step.planningPowerW === 0) return true;
      if (isEvTargetPowerConfig(config)) {
        return step.planningPowerW >= resolveCandidateMinPowerW(config)
          && step.planningPowerW <= resolveCandidateMaxPowerW(config);
      }
      return step.planningCurrentA !== undefined && config.currentLimits !== undefined
        && step.planningCurrentA >= config.currentLimits.minA && step.planningCurrentA <= config.currentLimits.maxA;
    }),
  } : confirmedProfile;
  if (!isEvTargetPowerConfig(config)) return planningProfile;
  const reachability = resolveValidTargetPowerReachability(config);
  if ((reachability?.nextProbeAtMs ?? 0) > nowMs) return planningProfile;
  const confirmedMaxW = Math.max(...planningProfile.steps.map((step) => step.planningPowerW));
  const nextCandidate = buildEvTargetPowerCandidateProfile(config).steps
    .find((step) => step.planningPowerW > confirmedMaxW);
  if (!nextCandidate) return planningProfile;
  return {
    ...planningProfile,
    steps: sortSteps([...planningProfile.steps, nextCandidate]),
  };
};

export const buildTargetPowerReachabilityState = (params: {
  config: TargetPowerConfigWithReachability;
  maxReachedPowerW: number;
  probeFailureCount?: number;
  nextProbeAtMs?: number;
}): TargetPowerReachabilityState | undefined => {
  const { config } = params;
  if (!isEvTargetPowerConfig(config)) return undefined;
  const maxReachedPowerW = resolveObservedPowerW(config, params.maxReachedPowerW);
  if (maxReachedPowerW === undefined) return undefined;
  return {
    profileFingerprint: buildEvTargetPowerProfileFingerprint(config),
    maxReachedPowerW,
    probeFailureCount: Math.max(0, Math.trunc(params.probeFailureCount ?? 0)),
    ...(params.nextProbeAtMs !== undefined ? { nextProbeAtMs: params.nextProbeAtMs } : {}),
  };
};

export const withoutTargetPowerReachability = (
  config: TargetPowerConfigWithReachability | undefined,
): TargetPowerSteppedLoadConfig | undefined => {
  if (!config?.reachability) return config;
  const { reachability: _reachability, ...baseConfig } = config;
  return baseConfig;
};
