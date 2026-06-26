import type { HomeyDeviceLike } from '../utils/types';
import { extractBatteryState } from './managerEnergy';

/**
 * Read-only home-battery awareness producer.
 *
 * Treats the battery read like every other PELS SDK read: it is consulted only on
 * a SUCCESSFUL device fetch, and emits a `battery_state_observed` event ONLY when a
 * home-battery device was actually read this poll AND both its SoC and power are
 * concrete finite numbers — carrying those typed numbers from that read. If any
 * needed value is missing (no battery present, a cap unreadable / non-finite, or
 * the fetch failed upstream) the whole emission is DROPPED: emit nothing, fabricate
 * nothing, carry on. Internal `null` (from `extractBatteryState`) is resolved to
 * either "emit typed numbers" or "drop" HERE — nothing nullable/undefined ever
 * crosses out of the device layer.
 *
 * There is NO retained value: a point-in-time successful observation is surfaced
 * purely as the structured event, nothing is held to go stale. The value is
 * awareness-only — it NEVER feeds the hard-cap import path; PELS never commands the
 * battery. A future consumer PR adds a synchronous holder/cache with its own
 * freshness when it needs to read the value.
 *
 * The only state held is the detected battery-id SET, used purely as a TARGETED-
 * REFRESH PERF hint: home batteries are non-managed and so excluded from the parsed
 * snapshot, so targeted (by-known-id) refreshes need these ids to keep re-reading
 * the battery between full refreshes. It holds IDs, not values; re-derived on each
 * non-empty full refresh; affects only WHICH ids get re-polled, never correctness.
 */
export type BatteryStateObservedEvent = {
    component: 'devices';
    event: 'battery_state_observed';
    batterySoc: number;
    batteryPowerW: number;
    batteryDeviceCount: number;
};

export type BatteryStateEventEmitter = (payload: BatteryStateObservedEvent) => void;

export class BatteryStateProducer {
    private batteryDeviceIds: ReadonlySet<string> = new Set();

    constructor(private readonly emit: BatteryStateEventEmitter) {}

    getBatteryDeviceIds(): string[] {
        return Array.from(this.batteryDeviceIds);
    }

    /**
     * Resolve the current battery aggregate from a SUCCESSFULLY fetched device list
     * and emit `battery_state_observed` ONLY when a battery was read this poll and
     * both SoC and power are finite numbers. Otherwise DROP (emit nothing).
     *
     * `fullRefresh` (when the list is non-empty) re-derives the battery-id set so
     * targeted refreshes know which non-managed batteries to re-read — a perf hint,
     * not value correctness.
     */
    observe(devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean }): void {
        const { batterySoc, batteryPowerW, batteryDeviceCount, batteryDeviceIds } = extractBatteryState(devices);
        if (options.fullRefresh && devices.length > 0) this.batteryDeviceIds = new Set(batteryDeviceIds);
        // Emit only with concrete finite numbers for BOTH fields; otherwise drop so
        // nothing nullable crosses out of the device layer.
        if (batterySoc === null || batteryPowerW === null) return;
        this.emit({
            component: 'devices',
            event: 'battery_state_observed',
            batterySoc,
            batteryPowerW,
            batteryDeviceCount,
        });
    }
}
