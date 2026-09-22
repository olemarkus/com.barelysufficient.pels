import { ModePriorityCatalog, type ModePriorityOrder } from '../../packages/shared-domain/src/settings/modePriorities';

/** Complete priority producer for objective fixtures that already declare a device order. */
export const createFixturePriorityQuery = (
  devices: readonly { id: string; priority?: number }[] = [],
): ((deviceIds: readonly string[]) => ModePriorityOrder) => {
  const catalog = new ModePriorityCatalog({
    Home: Object.fromEntries(devices.map((device) => [device.id, device.priority ?? 100])),
  });
  return (deviceIds) => catalog.getOrder('Home', deviceIds);
};
