type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
type TimerKind = 'timeout' | 'interval';

type TimerEntry = {
  handle: TimerHandle;
  kind: TimerKind;
};

export class TimerRegistry {
  private readonly timers = new Map<string, TimerEntry>();

  registerTimeout<T extends TimerHandle>(name: string, handle: T): T {
    return this.register(name, handle, 'timeout');
  }

  registerInterval<T extends TimerHandle>(name: string, handle: T): T {
    return this.register(name, handle, 'interval');
  }

  has(name: string): boolean {
    return this.timers.has(name);
  }

  clear(name: string): boolean {
    const entry = this.timers.get(name);
    if (!entry) return false;

    this.timers.delete(name);
    if (entry.kind === 'interval') {
      clearInterval(entry.handle as ReturnType<typeof setInterval>);
    } else {
      clearTimeout(entry.handle as ReturnType<typeof setTimeout>);
    }
    return true;
  }

  clearAll(): void {
    for (const name of [...this.timers.keys()]) {
      this.clear(name);
    }
  }

  private register<T extends TimerHandle>(name: string, handle: T, kind: TimerKind): T {
    this.clear(name);
    this.timers.set(name, { handle, kind });
    return handle;
  }
}
