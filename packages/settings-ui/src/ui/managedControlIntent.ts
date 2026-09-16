const generationByDeviceId = new Map<string, number>();

/**
 * Mark a new Managed-toggle intent before its first await. Both the device list
 * and detail panel share this sequence, so a later click on either surface
 * makes every older continuation stale.
 */
export const beginManagedControlIntent = (deviceId: string): number => {
  const generation = (generationByDeviceId.get(deviceId) ?? 0) + 1;
  generationByDeviceId.set(deviceId, generation);
  return generation;
};

export const isCurrentManagedControlIntent = (deviceId: string, generation: number): boolean => (
  generationByDeviceId.get(deviceId) === generation
);
