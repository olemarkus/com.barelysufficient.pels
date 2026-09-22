/**
 * Durable power-support failures have the same settings consequence for every
 * device kind: PELS cannot manage or apply price behavior to a device it cannot
 * measure. A temperature capability does not grant a separate control path.
 */
export type UnsupportedDeviceSupport<T> = {
  /** Every device without power support; all PELS control settings are disabled. */
  unsupported: T[];
  unsupportedIds: string[];
};

export function classifyUnsupportedDevices<T extends { id: string; powerCapable?: boolean }>(
  snapshot: readonly T[],
): UnsupportedDeviceSupport<T> {
  const unsupported = snapshot.filter((device) => device.powerCapable === false);
  return {
    unsupported,
    unsupportedIds: unsupported.map((device) => device.id),
  };
}
