// Pure starvation entry/exit threshold math, extracted from
// `deviceDiagnosticsService.ts` to keep that file under its line budget. The
// anchor table + interpolation + step quantization mirror
// `notes/starvation/README.md` § "Threshold Model" exactly — change the note and
// this file together.

import { isFiniteNumber } from '../utils/appTypeGuards';

const STARVATION_ENTRY_ANCHORS = [
  { targetC: 16, deficitC: 2 },
  { targetC: 21, deficitC: 2 },
  { targetC: 24, deficitC: 3 },
  { targetC: 55, deficitC: 10 },
  { targetC: 80, deficitC: 20 },
] as const;

export type StarvationThresholds = {
  entryDeficitC: number;
  entryThresholdC: number;
  exitDeficitC: number;
  exitThresholdC: number;
};

const roundUpToStep = (value: number, step: number): number => (
  Math.ceil(value / step) * step
);

const roundDownToStep = (value: number, step: number): number => (
  Math.floor(value / step) * step
);

const interpolateEntryDeficitC = (targetC: number): number => {
  const firstAnchor = STARVATION_ENTRY_ANCHORS[0];
  const lastAnchor = STARVATION_ENTRY_ANCHORS[STARVATION_ENTRY_ANCHORS.length - 1];
  if (targetC <= firstAnchor.targetC) return firstAnchor.deficitC;
  if (targetC >= lastAnchor.targetC) return lastAnchor.deficitC;

  for (let index = 1; index < STARVATION_ENTRY_ANCHORS.length; index += 1) {
    const previous = STARVATION_ENTRY_ANCHORS[index - 1];
    const current = STARVATION_ENTRY_ANCHORS[index];
    if (targetC > current.targetC) continue;
    const span = current.targetC - previous.targetC;
    const progress = span <= 0 ? 0 : (targetC - previous.targetC) / span;
    return previous.deficitC + ((current.deficitC - previous.deficitC) * progress);
  }

  return lastAnchor.deficitC;
};

export const buildStarvationThresholds = (
  intendedNormalTargetC: number | null,
  targetStepC: number | null,
): StarvationThresholds | null => {
  if (!isFiniteNumber(intendedNormalTargetC) || !isFiniteNumber(targetStepC) || targetStepC <= 0) {
    return null;
  }
  const entryDeficitC = Math.max(
    targetStepC,
    roundUpToStep(interpolateEntryDeficitC(intendedNormalTargetC), targetStepC),
  );
  const exitDeficitC = Math.max(targetStepC, roundDownToStep(entryDeficitC * 0.5, targetStepC));
  return {
    entryDeficitC,
    entryThresholdC: intendedNormalTargetC - entryDeficitC,
    exitDeficitC,
    exitThresholdC: intendedNormalTargetC - exitDeficitC,
  };
};
