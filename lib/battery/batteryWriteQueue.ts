/**
 * One write at a time per battery, in the order they were asked for: each
 * starts once the one before it settled, whatever that one answered. The
 * battery control owner's setpoints and hand-backs go through it
 * (`batteryControlOwner.ts`), so a hand-back never races a command.
 */
export class BatteryWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(deviceId: string, write: () => Promise<T>): Promise<T> {
    const work = (this.tails.get(deviceId) ?? Promise.resolve()).then(write);
    const settled = work.then(() => undefined, () => undefined);
    this.tails.set(deviceId, settled);
    void settled.then(() => { if (this.tails.get(deviceId) === settled) this.tails.delete(deviceId); });
    return work;
  }
}
