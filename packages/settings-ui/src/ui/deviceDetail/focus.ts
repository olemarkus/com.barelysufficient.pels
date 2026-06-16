import type { OpenDeviceDetailDetail } from '../cardActivation.ts';

// Re-exported so device-detail wiring imports the open-request type from one
// place rather than reaching across imports.
export type { OpenDeviceDetailDetail };

export type PendingDeviceDetailOpen = {
  deviceId: string;
};

// A device-detail open request that arrives before the device list has loaded
// is remembered here and replayed once `devices-updated` fires. Encapsulating
// the queue keeps the two-handler hand-off — the open handler writes, the
// refresh handler peeks then takes — as one cohesive concept rather than a bare
// module-level mutable.
//
// The refresh handler must `peek()` first and only `take()` (consume) once the
// target device is actually present: a `devices-updated` can fire while the
// requested device is still absent (a partial list, or an unrelated device
// change), and consuming the request unconditionally would drop it before the
// device ever loads, so the detail pane would never open.
export const createPendingDeviceDetailOpen = () => {
  let pending: PendingDeviceDetailOpen | null = null;
  return {
    set: (deviceId: string): void => {
      pending = { deviceId };
    },
    peek: (): PendingDeviceDetailOpen | null => pending,
    take: (): PendingDeviceDetailOpen | null => {
      const current = pending;
      pending = null;
      return current;
    },
  };
};
