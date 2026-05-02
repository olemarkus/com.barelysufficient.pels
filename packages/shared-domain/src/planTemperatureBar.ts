import type { SettingsUiPlanDeviceSnapshot } from '../../contracts/src/settingsUiApi.js';

export type PlanTemperatureBarView = {
  label: string;
  targetLabel: string;
  rangeLabel: string;
  fillLeftPct: number;
  fillWidthPct: number;
  currentPct: number;
  targetPct: number;
  setbackPct: number | null;
  progressTone: 'approaching' | 'held' | 'at_target' | 'above_target';
};

type Input = Pick<
  SettingsUiPlanDeviceSnapshot,
  'currentTemperature' | 'currentTarget' | 'plannedTarget' | 'shedTemperature' | 'controlModel' | 'plannedState'
>;

const MIN_RANGE_DEG = 2.0;

const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const formatDeg = (value: number): string => `${value.toFixed(1)}°`;

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

const pctOf = (value: number, lo: number, hi: number): number => {
  if (hi <= lo) return 0;
  return clampPct(((value - lo) / (hi - lo)) * 100);
};

const formatAbsDeg = (value: number): string => `${Math.abs(value).toFixed(1)}°`;

const formatDeltaLabel = (delta: number): string => {
  const magnitude = formatAbsDeg(delta);
  if (Math.abs(delta) < 0.2) return 'at target';
  return delta > 0 ? `${magnitude} above target` : `${magnitude} below target`;
};

const roundRange = (value: number): number => Math.ceil(value * 2) / 2;

export const resolveTemperatureBar = (device: Input): PlanTemperatureBarView | null => {
  if (device.controlModel !== 'temperature_target') return null;
  if (!isNum(device.currentTemperature)) return null;
  const target = isNum(device.plannedTarget) ? device.plannedTarget : device.currentTarget;
  if (!isNum(target)) return null;

  const current = device.currentTemperature;
  const heldBySetback = isNum(device.shedTemperature) && device.plannedState === 'shed';
  const setback = heldBySetback ? device.shedTemperature : null;
  const deltas = [
    current - target,
    ...(setback !== null ? [setback - target] : []),
  ];
  const rangeDeg = roundRange(Math.max(MIN_RANGE_DEG, ...deltas.map((delta) => Math.abs(delta))));
  const lo = -rangeDeg;
  const hi = rangeDeg;

  const currentPct = pctOf(current - target, lo, hi);
  const targetPct = pctOf(0, lo, hi);
  const setbackPct = setback !== null ? pctOf(setback - target, lo, hi) : null;
  const fillLeftPct = Math.min(currentPct, targetPct);
  const fillWidthPct = Math.abs(currentPct - targetPct);

  const atTarget = Math.abs(current - target) < 0.2;
  const resolveProgressTone = (): PlanTemperatureBarView['progressTone'] => {
    if (atTarget) return 'at_target';
    if (heldBySetback) return 'held';
    if (current > target) return 'above_target';
    return 'approaching';
  };
  const progressTone = resolveProgressTone();

  return {
    label: `${formatDeg(current)} · ${formatDeltaLabel(current - target)}`,
    targetLabel: `target ${formatDeg(target)}`,
    rangeLabel: `±${formatDeg(rangeDeg)}`,
    fillLeftPct,
    fillWidthPct,
    currentPct,
    targetPct,
    setbackPct,
    progressTone,
  };
};
