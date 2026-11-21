import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { SupportReportSection } from '../../packages/contracts/src/supportReport';
import type { HomeRuntimeReading } from '../home/homeRuntimeRead';
import { DEFAULT_POWER_SOURCE, type PowerSourceChoiceRead } from '../power/powerSource';
import { describeSupportReportMeter, type HomeyDeviceInventoryRead } from './homeyDeviceSupportSection';

const title = 'Current power source';

const describeSelection = (selection: MainMeterSelection, inventory: HomeyDeviceInventoryRead) => (
  selection.state === 'resolved'
    ? { state: selection.state, ...describeSupportReportMeter(inventory, selection.meterDeviceId) }
    : { state: selection.state }
);

export const reportMainPowerSource = (
  choice: PowerSourceChoiceRead,
  readMeterSelection: () => MainMeterSelection,
  inventory: HomeyDeviceInventoryRead,
): SupportReportSection => {
  if (choice.state === 'suspect') {
    return { title, values: { scope: 'main', selection: 'unavailable', reason: choice.reason } };
  }
  if (choice.state === 'unset') {
    return { title, values: { scope: 'main', selection: 'unset', source: DEFAULT_POWER_SOURCE } };
  }
  return {
    title,
    values: {
      scope: 'main',
      selection: 'chosen',
      source: choice.value,
      ...(choice.value === 'homey_energy' ? { meter: describeSelection(readMeterSelection(), inventory) } : {}),
    },
  };
};

export const reportAreaPowerSource = (
  area: HomeRuntimeReading | null,
  inventory: HomeyDeviceInventoryRead,
): SupportReportSection => {
  if (area === null) return { title, values: { scope: 'area', selection: 'unavailable' } };
  const { meterDeviceId } = area.diagnostics;
  return {
    title,
    values: {
      scope: 'area',
      source: 'area_meter',
      meter: meterDeviceId === null
        ? { state: 'unconfigured' }
        : { state: 'resolved', ...describeSupportReportMeter(inventory, meterDeviceId) },
    },
  };
};
