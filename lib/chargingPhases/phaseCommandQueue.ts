/** Serializes all writes for a charger and revokes commands that have not finished. */
export class ChargingPhaseCommandQueue {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();

  generation(deviceId: string): number { return this.generations.get(deviceId) ?? 0; }
  invalidate(deviceId: string): void { this.generations.set(deviceId, this.generation(deviceId) + 1); }
  hasWork(deviceId: string): boolean { return this.queues.has(deviceId); }

  run<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(deviceId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.queues.set(deviceId, next);
    void next.finally(() => {
      if (this.queues.get(deviceId) === next) this.queues.delete(deviceId);
    }).catch(() => undefined);
    return next;
  }
}
