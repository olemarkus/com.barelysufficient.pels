import type { SilentMeterDirective } from '../../../contracts/src/meterOutage.ts';

/**
 * What Main's latest rendered plan did without a measurement: the
 * silent-meter pass (`meta.powerIsMeasured` false) limited every device
 * (`shed`) or left them as they are (`hold`); `null` while the plan is
 * measured. The hero draws nothing for that cycle (owner ruling 2026-09-02),
 * so the no-readings banner carries the consequence line instead.
 *
 * A leaf module on purpose: the plan render (`planRedesign.ts`) knows the
 * plan and the banner (`capacity.ts`) renders the line, and neither may import
 * the other — `capacity → homeyEnergyMeter → advanced → devices → plan →
 * planRedesign` is already a chain, so a direct edge closed a cycle.
 */
let silentMeterPass: SilentMeterDirective | null = null;
let onChange: (() => void) | null = null;

export const getSilentMeterPass = (): SilentMeterDirective | null => silentMeterPass;

export const setSilentMeterPass = (value: SilentMeterDirective | null): void => {
  if (value === silentMeterPass) return;
  silentMeterPass = value;
  onChange?.();
};

/** The banner subscribes once; a flip re-renders it immediately. */
export const onPlanMeasurementChange = (listener: () => void): void => {
  onChange = listener;
};
