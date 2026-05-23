/**
 * Copy helpers for the device-level idle states surfaced to users:
 *
 *  - `near_target_idle`: device is at/near its setpoint and has stopped
 *    drawing — a deliberate hold by the device's own controller (water
 *    heater stratification, thermostat hysteresis). Neutral status line.
 *
 *  - `unresponsive`: device should be heating (well below setpoint) but is
 *    drawing nothing. Warning chip — likely a fault the user should act on.
 *
 *  - `capped_idle`: device is well below the PELS-commanded target but its
 *    own internal setpoint cap has opened — temperature parks at a stable
 *    plateau while power cycles. The device is doing the right thing
 *    against its own cap; PELS just commanded higher than the device allows.
 *    Neutral status line — no warning chip, but the recourse copy points at
 *    the device's own setpoint cap (not the PELS hard cap, which is a
 *    physical-line concept per `feedback_hard_cap_is_physical.md`).
 *
 * Used by both the Settings UI device card and structured-log payloads so
 * the two never drift. The temperature gap is rendered when both readings
 * are present and finite; copy degrades gracefully when they are not.
 */

export type IdleClassification = 'near_target_idle' | 'unresponsive' | 'capped_idle';

export type IdleClassificationCopyInput = {
  classification: IdleClassification;
  currentTemperatureC?: number;
  targetTemperatureC?: number;
};

export type IdleClassificationCopy = {
  /** Short status line for the device card. */
  statusLine: string;
  /** Longer explanation suitable for a tooltip or diagnostic event. */
  detail: string;
  /** UI tone for the chip; warning is shown for unresponsive only. */
  tone: 'neutral' | 'warning';
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const formatTemperature = (value: number): string => {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}°` : `${rounded.toFixed(1)}°`;
};

const formatTemperaturePair = (
  current: number | undefined,
  target: number | undefined,
): string | null => {
  if (!isFiniteNumber(current) || !isFiniteNumber(target)) return null;
  return `${formatTemperature(current)} / ${formatTemperature(target)}`;
};

const NEAR_TARGET_DETAIL_PREFIX = 'Device has stopped drawing while close to its setpoint';
const NEAR_TARGET_DETAIL_SUFFIX = "This is normal behaviour for the device's own controller.";

const buildNearTargetIdleCopy = (
  pair: string | null,
): IdleClassificationCopy => ({
  statusLine: pair ? `Holding near setpoint (${pair})` : 'Holding near setpoint',
  detail: pair
    ? `${NEAR_TARGET_DETAIL_PREFIX} (${pair}). ${NEAR_TARGET_DETAIL_SUFFIX}`
    : `${NEAR_TARGET_DETAIL_PREFIX}. ${NEAR_TARGET_DETAIL_SUFFIX}`,
  tone: 'neutral',
});

const buildUnresponsiveCopy = (
  pair: string | null,
): IdleClassificationCopy => ({
  statusLine: pair ? `Not responding (${pair})` : 'Not responding',
  detail: pair
    ? `Device should be heating (${pair}) but is drawing no power. Check the breaker, power supply, or device wiring.`
    : 'Device should be heating but is drawing no power. Check the breaker, power supply, or device wiring.',
  tone: 'warning',
});

// "Setpoint cap" names the device's OWN internal maximum (e.g. Connected 300
// at ~60 °C) — deliberately not the PELS hard cap, which is the physical
// service-line limit and is never a remedy the user should be told to
// raise. Per `feedback_hard_cap_is_physical.md` the noun for the
// PELS-canonical limit is "hard cap"; this state needs its own noun so the
// recourse text doesn't conflate the two.
const CAPPED_IDLE_DETAIL_PREFIX = 'Device reached its own setpoint cap';
const CAPPED_IDLE_DETAIL_SUFFIX = "PELS commanded a higher target, but the device's own thermostat or "
  + 'internal cap holds it lower. Raise the cap on the device itself if you want it to heat further.';

const buildCappedIdleCopy = (
  pair: string | null,
): IdleClassificationCopy => ({
  statusLine: pair
    ? `Device reached its own setpoint cap (${pair})`
    : 'Device reached its own setpoint cap',
  detail: pair
    ? `${CAPPED_IDLE_DETAIL_PREFIX} (${pair}). ${CAPPED_IDLE_DETAIL_SUFFIX}`
    : `${CAPPED_IDLE_DETAIL_PREFIX}. ${CAPPED_IDLE_DETAIL_SUFFIX}`,
  tone: 'neutral',
});

export function formatIdleClassificationCopy(
  input: IdleClassificationCopyInput,
): IdleClassificationCopy {
  const pair = formatTemperaturePair(input.currentTemperatureC, input.targetTemperatureC);
  if (input.classification === 'unresponsive') return buildUnresponsiveCopy(pair);
  if (input.classification === 'capped_idle') return buildCappedIdleCopy(pair);
  return buildNearTargetIdleCopy(pair);
}
