import type { SettingsUiDevicesPayload } from '../../packages/contracts/src/settingsUiApi';
import { MAIN_HOME_ID } from '../utils/settingsKeys';
import type { PelsHost } from './pelsHost';
import { appNotReadyError } from './settingsUiReadiness';

/** The application read model owns Main-home inverter selection and readiness. */
export const readSettingsUiInverterDevices = (host: PelsHost): SettingsUiDevicesPayload['inverterDevices'] => {
  const { deviceManager, homeMembership } = host;
  if (!deviceManager || !deviceManager.hasWarmSnapshot()) throw appNotReadyError('Inverter controls');
  const devices = deviceManager.readInverterControlOptions();
  if (devices.length === 0) return devices;
  if (!homeMembership) throw appNotReadyError('Home membership');
  return homeMembership.filterDevicesForHome(devices, MAIN_HOME_ID);
};
