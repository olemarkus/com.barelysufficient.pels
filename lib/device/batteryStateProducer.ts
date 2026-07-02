import type { HomeyDeviceLike } from '../utils/types';
import { extractBatteryState, isHomeBatteryDevice } from './managerEnergy';

/**
 * Read-only home-battery awareness producer.
 *
 * Treats the battery read like every other PELS SDK read: it is consulted only on
 * a SUCCESSFUL device fetch, and emits a `battery_state_observed` event ONLY when a
 * home-battery device was actually read this poll AND both its SoC and power are
 * concrete finite numbers — carrying those typed numbers from that read. If any
 * needed value is missing (no battery present, a cap unreadable / non-finite /
 * out-of-range, an offline-only battery, or the fetch failed upstream) the whole
 * emission is DROPPED: emit nothing, fabricate nothing, carry on. Internal `null`
 * (from `extractBatteryState`) is resolved to either "emit typed numbers" or "drop"
 * HERE — nothing nullable/undefined ever crosses out of the device layer.
 *
 * There is NO retained value: a point-in-time successful observation is surfaced
 * purely as the structured event, nothing is held to go stale. The value is
 * awareness-only — it NEVER feeds the hard-cap import path; PELS never commands the
 * battery (a battery is `managed: true, controllable: false` and non-temperature,
 * so the existing planner gates keep it inert).
 *
 * The only state held is the detected battery-id SET (plus its narrowing-grace
 * counter). The AUTHORITATIVE managed observe-only resolution is STRUCTURAL at
 * parse (`resolveDeviceClassKey` + `resolveParsedDeviceSettings`, from the device
 * object) and the planner reads that snapshot stamp. This set is the SECONDARY
 * agreement for the deviceId-only resolve* consumers
 * (`resolveManagedState`/`isCapacityControlEnabled` → autocomplete,
 * shortfall-hint, realtime-tracking) that have no device object in hand, and the
 * whole-set read (`hasBatteryDevices`) suppresses the curtailment-surplus term on
 * battery homes. It holds IDs, not values: re-derived on each non-empty full
 * refresh that still sees a battery, and additively topped up from the realtime
 * path (`noteBatteryDevice`) so it is never empty for a present battery before
 * the first full refresh. Includes offline batteries so a managed battery keeps
 * its managed identity (and recovers) while briefly unavailable.
 *
 * NARROWING GRACE: a full refresh that sees NO battery at all only empties a
 * previously-populated set after `BATTERY_SET_NARROW_GRACE_REFRESHES`
 * consecutive battery-free full refreshes. A single omission is
 * indistinguishable from the battery's providing app restarting (Homey SDK
 * reads transiently fail — a gap is not a removal), and a premature
 * `hasBatteryDevices()` flip would un-suppress the curtailment term on a
 * battery home mid-blip, where its verify loop can then falsely confirm. The
 * grace lives HERE, not in a consumer wrapper: only the producer sees
 * full-refresh boundaries (consumers read per plan tick, so a consumer-side
 * consecutive-miss count would saturate within one refresh interval), and every
 * id-based consumer is exposed to the same one-refresh blip. A refresh that
 * still sees ANY battery re-derives immediately (a partial narrowing is
 * same-fetch evidence, not a blip).
 */
export type BatteryStateObservedEvent = {
    component: 'devices';
    event: 'battery_state_observed';
    batterySoc: number;
    batteryPowerW: number;
    batteryDeviceCount: number;
};

export type BatteryStateEventEmitter = (payload: BatteryStateObservedEvent) => void;

// Consecutive battery-free FULL refreshes required before a previously-populated
// battery set narrows to empty (see the NARROWING GRACE docblock above).
// Dogfood-tunable; at the periodic full-refresh cadence this bounds a genuine
// removal's staleness to a few cycles while riding out a battery-app restart.
export const BATTERY_SET_NARROW_GRACE_REFRESHES = 3;

export class BatteryStateProducer {
    private batteryDeviceIds: ReadonlySet<string> = new Set();
    private consecutiveBatteryFreeRefreshes = 0;

    constructor(private readonly emit: BatteryStateEventEmitter) {}

    /** Whether `deviceId` is a currently-detected home battery (incl. offline). */
    isBatteryDevice(deviceId: string): boolean {
        return this.batteryDeviceIds.has(deviceId);
    }

    /** Whether ANY home battery is currently detected (incl. offline). Consumed by
     *  the curtailment-surplus producer (battery homes suppress the inferred term). */
    hasBatteryDevices(): boolean {
        return this.batteryDeviceIds.size > 0;
    }

    /**
     * ADDITIVELY record a role-detected battery's id (no-op for non-batteries). Used
     * by the realtime `device.update` path so the membership set is never empty for a
     * present battery before the first full refresh — keeping the deviceId-only
     * resolve* consumers (autocomplete, shortfall-hint) in agreement with the
     * structural parse stamp. Additive only: it never narrows the set (a full refresh
     * re-derives it), so it cannot strand a battery the full refresh already knows.
     */
    noteBatteryDevice(device: HomeyDeviceLike): void {
        if (!isHomeBatteryDevice(device)) return;
        // Realtime proof a battery exists — any narrowing grace in progress resets.
        this.consecutiveBatteryFreeRefreshes = 0;
        if (this.batteryDeviceIds.has(device.id)) return;
        this.batteryDeviceIds = new Set([...this.batteryDeviceIds, device.id]);
    }

    /**
     * Resolve the current battery aggregate from a SUCCESSFULLY fetched device list
     * and emit `battery_state_observed` ONLY when an available battery was read this
     * poll and both SoC and power are finite numbers. Otherwise DROP (emit nothing).
     *
     * `fullRefresh` (when the list is non-empty) re-derives the battery-id set so the
     * managed/controllable resolution knows which devices are batteries — a targeted
     * (by-known-id) refresh re-reads the SAME known ids and must not narrow the set.
     */
    observe(devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean }): void {
        const { batterySoc, batteryPowerW, batteryDeviceCount, batteryDeviceIds } = extractBatteryState(devices);
        if (options.fullRefresh && devices.length > 0) {
            this.applyFullRefreshMembership(batteryDeviceIds);
        }
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

    // Full-refresh membership update with the narrowing grace: a refresh that
    // still sees any battery re-derives immediately; a battery-FREE refresh only
    // empties a populated set after the consecutive-miss grace (a one-refresh
    // omission is a providing-app blip, not a removal).
    private applyFullRefreshMembership(batteryDeviceIds: readonly string[]): void {
        if (batteryDeviceIds.length > 0) {
            this.batteryDeviceIds = new Set(batteryDeviceIds);
            this.consecutiveBatteryFreeRefreshes = 0;
            return;
        }
        if (this.batteryDeviceIds.size === 0) return; // nothing to narrow
        this.consecutiveBatteryFreeRefreshes += 1;
        if (this.consecutiveBatteryFreeRefreshes >= BATTERY_SET_NARROW_GRACE_REFRESHES) {
            this.batteryDeviceIds = new Set();
            this.consecutiveBatteryFreeRefreshes = 0;
        }
    }
}
