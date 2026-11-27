import type { MeterInventoryDevice } from '../../lib/utils/types';
import { projectMeterDevice } from '../../lib/device/transport/meterInventory';

export const inventoryRead = <Entry>(rows: readonly Entry[]) => (
  <T>(collect: (entries: AsyncIterable<Entry>) => Promise<T>): Promise<T> => (
    collect((async function* entries() { yield* rows; })())
  )
);

/** Bind both weather reads to the same simulated Web API. */
export function weatherApiReads(fetchFromHomeyApi: (path: string) => Promise<unknown>) {
  return {
    fetchFromHomeyApi,
    readMeterInventory: async <T>(collect: (entries: AsyncIterable<MeterInventoryDevice>) => Promise<T>) => {
      const payload = await fetchFromHomeyApi('manager/devices/device');
      const entries = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.values(payload) : [];
      return inventoryRead(entries.map(projectMeterDevice))(collect);
    },
  };
}
