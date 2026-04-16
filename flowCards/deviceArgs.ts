import type { FlowAutocompleteResult, TargetDeviceSnapshot } from '../lib/utils/types';

export type RawFlowDeviceArg = string | { id?: string; name?: string; data?: { id?: string } };

export function getDeviceIdFromFlowArg(arg: RawFlowDeviceArg | null | undefined): string {
  const rawId = typeof arg === 'object' && arg !== null ? arg.id || arg.data?.id : arg;
  return typeof rawId === 'string' ? rawId.trim() : '';
}

export function buildDeviceAutocompleteOptions(
  devices: Array<Pick<TargetDeviceSnapshot, 'id' | 'name'>>,
  query: unknown,
): FlowAutocompleteResult[] {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const nameCounts = new Map<string, number>();
  for (const device of devices) {
    nameCounts.set(device.name, (nameCounts.get(device.name) ?? 0) + 1);
  }
  return devices
    .filter((device) => (
      !normalizedQuery
      || device.name.toLowerCase().includes(normalizedQuery)
      || device.id.toLowerCase().includes(normalizedQuery)
    ))
    .map((device) => ({
      id: device.id,
      name: (nameCounts.get(device.name) ?? 0) > 1 ? `${device.name} (${device.id})` : device.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
