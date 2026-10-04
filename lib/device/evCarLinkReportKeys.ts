/** Bound on the one-shot report-dedupe ring (see `EvCarLinkReportKeys.claim`). */
const MAX_REPORTED_KEYS = 200;

/**
 * One-shot dedupe for events derived from retained edges, which are re-matched
 * on every correlation pass. Bounded by `MAX_REPORTED_KEYS`: edges expire long
 * before the cap, so eviction only ever discards keys whose edges are gone —
 * it cannot resurrect a duplicate for a live edge.
 */
export class EvCarLinkReportKeys {
    private reportedKeys: string[] = [];
    private readonly reportedKeySet = new Set<string>();

    /** Returns `false` when this key was already reported; records it otherwise. */
    claim(key: string): boolean {
        if (this.reportedKeySet.has(key)) return false;
        this.reportedKeySet.add(key);
        this.reportedKeys = [...this.reportedKeys, key];
        if (this.reportedKeys.length > MAX_REPORTED_KEYS) {
            const [evicted, ...rest] = this.reportedKeys;
            this.reportedKeys = rest;
            if (evicted !== undefined) this.reportedKeySet.delete(evicted); // Length-checked above.
        }
        return true;
    }
}
