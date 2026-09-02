/**
 * Whether the plan currently rendered on the Overview was built without a
 * measurement — the silent-meter fail-closed pass (`meta.powerIsMeasured`
 * false). The hero draws nothing for that cycle (owner ruling 2026-09-02), so
 * the no-readings banner carries the consequence line instead.
 *
 * A leaf module on purpose: the plan render (`planRedesign.ts`) knows the
 * plan and the banner (`capacity.ts`) renders the line, and neither may import
 * the other — `capacity → homeyEnergyMeter → advanced → devices → plan →
 * planRedesign` is already a chain, so a direct edge closed a cycle.
 */
let planUnmeasured = false;
let onChange: (() => void) | null = null;

export const isPlanUnmeasured = (): boolean => planUnmeasured;

export const setPlanUnmeasured = (value: boolean): void => {
  if (value === planUnmeasured) return;
  planUnmeasured = value;
  onChange?.();
};

/** The banner subscribes once; a flip re-renders it immediately. */
export const onPlanMeasurementChange = (listener: () => void): void => {
  onChange = listener;
};
