/**
 * Owns serialization for Flow-conflict scans.
 *
 * Background requests are best-effort and are dropped while any scan is
 * pending. An explicit request is always queued behind work that began before
 * it, so the scan serving a user's "Check again" starts after that request.
 * See notes/native-wiring/README.md.
 */
export type FlowConflictRefreshResult =
  | { readonly state: 'resolved' }
  | { readonly state: 'unavailable' };

export type FlowConflictRefreshRun = () => Promise<FlowConflictRefreshResult>;

export class FlowConflictRefreshCoordinator {
  private tail?: Promise<FlowConflictRefreshResult>;

  requestBackground(run: FlowConflictRefreshRun): Promise<void> {
    if (this.tail !== undefined) return Promise.resolve();
    return this.enqueue(run).then(() => undefined);
  }

  requestExplicit(run: FlowConflictRefreshRun): Promise<FlowConflictRefreshResult> {
    return this.enqueue(run);
  }

  private enqueue(run: FlowConflictRefreshRun): Promise<FlowConflictRefreshResult> {
    const predecessor = this.tail;
    const ready = predecessor === undefined
      ? Promise.resolve()
      : predecessor.then(() => undefined, () => undefined);
    const execution = ready.then(run);
    const tracked = execution.finally(() => {
      if (this.tail === tracked) this.tail = undefined;
    });
    this.tail = tracked;
    return tracked;
  }
}
