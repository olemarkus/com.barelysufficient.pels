/**
 * Producer-resolved Main meter selection.
 *
 * `resolved` carries either one explicit meter id or `null` for Automatic.
 * `unavailable` means the settings adapter cannot currently establish which
 * selection is authoritative. Raw SDK shapes/errors never cross this contract.
 */
export type MainMeterSelection =
  | { state: 'resolved'; meterDeviceId: string | null }
  | { state: 'unavailable' };
