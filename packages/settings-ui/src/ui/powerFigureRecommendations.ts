import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { supportsTemperatureDevice, type SettingsUiDeviceDetailItem } from './deviceUtils.ts';
import type { SetupRecommendation } from './recommendationsModel.ts';

/** A power figure as the owner reads it: watts below 1 kW, else kW to one decimal. */
const formatPowerFigure = (kw: number): string => (
  kw < 1 ? `${Math.round(kw * 100) * 10} W` : `${kw.toFixed(1)} kW`
);

/**
 * A device PELS sees draw well above the figure it plans it with
 * (`powerFigureCheck`, `lib/device/powerFigureCheck.ts`). PELS sets that figure
 * aside each time it turns the device back on, so a low one lets a restore run
 * the home past its limit. The owner may know better, so this asks: dismissing
 * it says the figure is right. Its version is that figure in 100 W steps, so
 * a dismissal holds while the figure stands, however the measured median
 * moves between switch-offs, and it returns once the figure changes. The caller passes
 * managed devices only.
 */
export const resolvePowerFigureRecommendations = (
  devices: readonly SettingsUiDeviceDetailItem[],
): SetupRecommendation[] => devices.flatMap((device): SetupRecommendation[] => {
  const check = device.powerFigureCheck;
  if (!check) return [];
  const name = formatDisplayDeviceName(device.name);
  const measuredKw = Math.round(check.measuredKw * 10) / 10;
  const measured = formatPowerFigure(measuredKw);
  const figure = formatPowerFigure(check.figureKw);
  const base = {
    id: `power-figure:${encodeURIComponent(device.id)}`,
    version: Math.max(1, Math.round(check.figureKw * 10)),
    category: 'recommendation',
    title: `Check the power for ${name}`,
  } as const;
  const useMeasured = {
    actionLabel: `Use ${measured}`,
    target: { kind: 'expected-power', deviceId: device.id, kw: measuredKw },
  } as const;
  const seen = `PELS sees about ${measured} leave your home each time it turns ${name} off`;
  const dismiss = `If ${figure} is right, dismiss this.`;
  switch (check.figure) {
    case 'typed':
      return [{ ...base, ...useMeasured, body: `${seen}, but plans with your figure, ${figure}. ${dismiss}` }];
    case 'flow':
      return [{
        ...base,
        body: `${seen}, but a Flow sets its figure to ${figure}. Change the figure in that Flow. ${dismiss}`,
        actionLabel: 'Open device',
        target: { kind: 'device', deviceId: device.id, focus: 'expected-power' },
      }];
    case 'load_setting':
      return [{
        ...base,
        ...useMeasured,
        body: `${seen}, but its own settings in Homey say ${figure}. `
          + `Correct that setting in Homey, or use ${measured} in PELS. ${dismiss}`,
      }];
    case 'homey_energy':
      return [{
        ...base, ...useMeasured, body: `${seen}, but Homey’s energy information for it says ${figure}. ${dismiss}`,
      }];
    case 'device_reading':
      return [{
        ...base,
        ...useMeasured,
        body: `${name} reports ${figure} while it runs, but your home drops about ${measured} each time PELS `
          + 'turns it off. Its reading may be low, for example from how it is wired, or come from a power setting '
          + `in its app. ${dismiss}`,
      }];
    case 'default':
      return [{
        ...base, ...useMeasured, body: `${seen}, but PELS had no figure for it and assumed ${figure}. ${dismiss}`,
      }];
    case 'highest_level':
      return [{
        ...base,
        body: `${name} has drawn up to ${measured}, but its highest level is ${figure}, so PELS sets too little `
          + 'aside each time it turns it back on.'
          + (supportsTemperatureDevice(device) ? ' Without levels, PELS controls it by its temperature.' : '')
          + ` ${dismiss}`,
        actionLabel: 'Review levels',
        target: { kind: 'device', deviceId: device.id, focus: 'levels' },
      }];
    default:
      return [];
  }
});
