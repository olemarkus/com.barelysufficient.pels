import type { DeviceLimitChange, DeviceLimitEvent } from '../ports/deviceLimitEvents';

/** Tracks limits applied by this executor during its lifetime. */
export class DeviceLimitEpisodes {
  private readonly active = new Map<string, { atMs: number; turnedOff: boolean }>();

  constructor(private readonly emit: (event: DeviceLimitEvent) => void) {}

  record(deviceId: string, deviceName: string, atMs: number, change: DeviceLimitChange): void {
    const episode = this.active.get(deviceId);
    if (change.kind === 'resumed') {
      if (!episode) return;
      this.active.delete(deviceId);
      this.emit({ ...change, deviceId, deviceName, atMs, limitedAtMs: episode.atMs });
      return;
    }

    const turnedOff = change.action === 'turned_off';
    // A fresh OFF command after an earlier OFF means the device was in use
    // again. Escalating a running limit to OFF remains part of the same hold.
    if (episode && !(episode.turnedOff && turnedOff)) {
      if (turnedOff) this.active.set(deviceId, { atMs: episode.atMs, turnedOff });
      return;
    }
    this.active.set(deviceId, { atMs, turnedOff });
    this.emit({ ...change, deviceId, deviceName, atMs });
  }

  forget(deviceId: string): void {
    this.active.delete(deviceId);
  }

  noteRunning(deviceId: string): void {
    const episode = this.active.get(deviceId);
    if (episode?.turnedOff) this.active.set(deviceId, { atMs: episode.atMs, turnedOff: false });
  }

  retainDevices(
    planned: Pick<ReadonlyMap<string, unknown>, 'has'>,
    isBackOn: (deviceId: string) => boolean,
  ): void {
    for (const [deviceId, episode] of this.active) {
      if (!planned.has(deviceId) || (episode.turnedOff && isBackOn(deviceId))) this.forget(deviceId);
    }
  }
}
