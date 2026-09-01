/**
 * One observer-owned confirmation policy for every control axis AND every
 * device.
 *
 * Command kind is deliberately absent: a binary switch, temperature target,
 * and stepped target on the same transport deserve the same observation
 * window. The per-device cloud tier (3 min) was removed 2026-09-01 together
 * with the `device_communication_models` settings map that fed it — nothing
 * ever wrote that map, so every device already ran this window in practice.
 */
export const CONTROL_COMMAND_CONFIRMATION_MS = 90 * 1000;
