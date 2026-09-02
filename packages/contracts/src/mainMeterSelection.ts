/**
 * Producer-resolved Main meter selection.
 *
 * `resolved` always names one explicit meter device id — there is no
 * Automatic. `unavailable` means the settings adapter cannot currently
 * establish an authoritative selection: a suspect/failed read, a malformed
 * stored value, or a legacy Automatic install whose owner has not picked a
 * meter yet. Raw SDK shapes/errors never cross this contract.
 */
export type MainMeterSelection =
  | { state: 'resolved'; meterDeviceId: string }
  | { state: 'unavailable' };
