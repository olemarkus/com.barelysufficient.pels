import { deviceDetailChargingSection, deviceDetailSheddingSection, deviceDetailSurplusTrackRow } from '../dom.ts';
import { resolveDeviceDetailKind } from '../deviceKind.ts';
import type { SettingsUiDeviceView } from '../state.ts';
import { initEvBoostHandlers, renderEvBoostSettings, supportsEvBoostDevice } from './evBoost.ts';
import {
  initEvChargeTargetHandlers,
  renderEvChargeTargetSettings,
  supportsEvChargeTargetDevice,
} from './evChargeTarget.ts';

// An EV charger's Charging card: when and how much to charge. It holds the
// battery level PELS charges to (evChargeTarget.ts), Charge boost (evBoost.ts),
// and the Charge on solar surplus row the section layout moves in.

/**
 * The Charging card shows on a managed EV charger that has a charging rule to
 * offer: a battery level (every charger), Charge boost (a stepped charger), or
 * Charge on solar surplus, whose row setDeviceDetailSurplusTrackingControl has
 * already resolved on this refresh.
 *
 * The Power limiting card shows for every kind but a battery, which carries its
 * own switches. An unmanaged charger has nothing to charge toward or limit, so
 * both cards go and the page reduces to Car and Setup, which auto-expands for it.
 */
export const setDeviceDetailChargingCardState = (
  device: SettingsUiDeviceView | null,
  controlState: { isManaged: boolean },
) => {
  const kind = resolveDeviceDetailKind(device);
  const isUnmanagedCharger = kind === 'ev_charger' && !controlState.isManaged;
  const hasChargingRule = supportsEvChargeTargetDevice(device)
    || supportsEvBoostDevice(device)
    || deviceDetailSurplusTrackRow?.hidden === false;
  if (deviceDetailChargingSection) {
    deviceDetailChargingSection.hidden = kind !== 'ev_charger' || isUnmanagedCharger || !hasChargingRule;
  }
  if (deviceDetailSheddingSection) deviceDetailSheddingSection.hidden = kind === 'battery' || isUnmanagedCharger;
};

export const renderChargingCardSettings = (device: SettingsUiDeviceView | null) => {
  renderEvChargeTargetSettings(device);
  renderEvBoostSettings(device);
};

export const initChargingCardHandlers = (deps: Parameters<typeof initEvBoostHandlers>[0]) => {
  initEvBoostHandlers(deps);
  initEvChargeTargetHandlers(deps);
};
