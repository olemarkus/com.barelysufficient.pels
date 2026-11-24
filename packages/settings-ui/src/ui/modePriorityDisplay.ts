import type { ModePriorityCatalog } from '../../../shared-domain/src/settings/modePriorities.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import { isLastResortConfigured } from './devicePowerSetup.ts';
import { isHomeBatteryDeviceId } from './state.ts';

export const chargingPriorityGroup = (device: SettingsUiDeviceListItem): string | undefined => (
  device.controlAdapter?.chargingInstallation?.mainId
);

export const orderModePriorityDevices = (
  catalog: ModePriorityCatalog, mode: string, devices: readonly SettingsUiDeviceListItem[],
): SettingsUiDeviceListItem[] => {
  const groups = new Map(devices.map((device) => [device.id, chargingPriorityGroup(device)]));
  const order = catalog.getOrder(mode, devices.map(({ id }) => id), isHomeBatteryDeviceId,
    isLastResortConfigured, (id) => groups.get(id));
  return [...devices].sort((a, b) => order.getPriority(a.id) - order.getPriority(b.id));
};

export const rankDisplayedModePriorities = <T>(
  ordered: readonly T[], groupOf: (item: T) => string | undefined,
): { item: T; rank: number }[] => {
  const groupRanks = new Map<string, number>();
  let displayRank = 0;
  return ordered.map((item) => {
    const group = groupOf(item);
    const existingRank = group === undefined ? undefined : groupRanks.get(group);
    const rank = existingRank ?? ++displayRank;
    if (group !== undefined) groupRanks.set(group, rank);
    return { item, rank };
  });
};
