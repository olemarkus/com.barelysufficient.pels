/**
 * Where the figure PELS plans a device with came from, as the power-figure
 * check names it to the owner (`lib/device/powerFigureCheck.ts`).
 *
 * - `typed`: "Power when running", typed on the device page.
 * - `flow`: "Power when running", set by the "Set expected power" Flow card.
 * - `load_setting`: the device's own load setting in Homey.
 * - `homey_energy`: Homey's energy information for the device.
 * - `device_reading`: the device's own power reading.
 * - `default`: PELS had no figure and assumed one.
 * - `highest_level`: a stepped device's highest level.
 */
export type PowerFigureKind =
  | 'typed'
  | 'flow'
  | 'load_setting'
  | 'homey_energy'
  | 'device_reading'
  | 'default'
  | 'highest_level';

/**
 * PELS sees a device draw well above the figure it plans the device with.
 *
 * `measuredKw` is the home meter's fall at the device's lone switch-offs for an
 * on/off device, and the device's own highest reading against its levels for a
 * stepped one (`figure: 'highest_level'`). Present only while they disagree.
 */
export type PowerFigureCheck = {
  measuredKw: number;
  figureKw: number;
  figure: PowerFigureKind;
};
