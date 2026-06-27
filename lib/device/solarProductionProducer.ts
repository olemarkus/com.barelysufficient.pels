import type { HomeyDeviceLike } from '../utils/types';
import { extractSolarProductionState, isSolarPanelDevice } from './managerEnergy';

/**
 * Read-only PV / solar production awareness producer.
 *
 * Mirrors `BatteryStateProducer`. Consulted only on a SUCCESSFUL device fetch; emits a
 * `solar_production_observed` event ONLY when an available solar device was actually
 * read this poll AND its production is a concrete finite number — carrying that typed
 * number from the read. If any needed value is missing (no solar present, an unreadable
 * / non-finite `measure_power`, an offline-only solar device, or the fetch failed
 * upstream) the whole emission is DROPPED: emit nothing, fabricate nothing, carry on.
 * Internal `null` (from `extractSolarProductionState`) is resolved to either "emit a
 * typed number" or "drop" HERE — nothing nullable/undefined ever crosses out of the
 * device layer.
 *
 * There is NO retained value: a point-in-time successful observation is surfaced purely
 * as the structured event. The value is observe-only telemetry — it NEVER feeds the
 * hard-cap import path NOR the whole-home generation aggregate (which grosses up the
 * managed/unmanaged split from the SEPARATE `totalGenerated.W` energy report); feeding
 * per-device PV into that would double-count. PELS never commands the solar device (it
 * is `managed: true, controllable: false` and non-temperature, so the existing planner
 * gates keep it inert).
 *
 * The only state held is the detected solar-id SET. The AUTHORITATIVE managed
 * observe-only resolution is STRUCTURAL at parse (`resolveDeviceClassKey` +
 * `resolveParsedDeviceSettings`, from the device object) and the planner reads that
 * snapshot stamp. This set is the SECONDARY agreement for the deviceId-only resolve*
 * consumers (`resolveManagedState`/`isCapacityControlEnabled` → autocomplete,
 * shortfall-hint, realtime-tracking) that have no device object in hand. It holds IDs,
 * not values: re-derived on each non-empty full refresh, and additively topped up from
 * the realtime path (`noteSolarDevice`) so it is never empty for a present solar device
 * before the first full refresh. Includes offline solar devices so a managed solar
 * device keeps its managed identity (and recovers) while briefly unavailable.
 */
export type SolarProductionObservedEvent = {
    component: 'devices';
    event: 'solar_production_observed';
    productionW: number;
    solarDeviceCount: number;
};

export type SolarProductionEventEmitter = (payload: SolarProductionObservedEvent) => void;

export class SolarProductionProducer {
    private solarDeviceIds: ReadonlySet<string> = new Set();

    constructor(private readonly emit: SolarProductionEventEmitter) {}

    /** Whether `deviceId` is a currently-detected solar device (incl. offline). */
    isSolarDevice(deviceId: string): boolean {
        return this.solarDeviceIds.has(deviceId);
    }

    /**
     * ADDITIVELY record a role-detected solar device's id (no-op for non-solar). Used
     * by the realtime `device.update` path so the membership set is never empty for a
     * present solar device before the first full refresh — keeping the deviceId-only
     * resolve* consumers (autocomplete, shortfall-hint) in agreement with the structural
     * parse stamp. Additive only: it never narrows the set (a full refresh re-derives
     * it), so it cannot strand a solar device the full refresh already knows.
     */
    noteSolarDevice(device: HomeyDeviceLike): void {
        if (!isSolarPanelDevice(device) || this.solarDeviceIds.has(device.id)) return;
        this.solarDeviceIds = new Set([...this.solarDeviceIds, device.id]);
    }

    /**
     * Resolve the current solar production aggregate from a SUCCESSFULLY fetched device
     * list and emit `solar_production_observed` ONLY when an available solar device was
     * read this poll and its production is a finite number. Otherwise DROP (emit nothing).
     *
     * `fullRefresh` (when the list is non-empty) re-derives the solar-id set so the
     * managed/controllable resolution knows which devices are solar — a targeted
     * (by-known-id) refresh re-reads the SAME known ids and must not narrow the set.
     */
    observe(devices: readonly HomeyDeviceLike[], options: { fullRefresh: boolean }): void {
        const { productionW, solarDeviceCount, solarDeviceIds } = extractSolarProductionState(devices);
        if (options.fullRefresh && devices.length > 0) this.solarDeviceIds = new Set(solarDeviceIds);
        // Emit only with a concrete finite production number; otherwise drop so nothing
        // nullable crosses out of the device layer.
        if (productionW === null) return;
        this.emit({
            component: 'devices',
            event: 'solar_production_observed',
            productionW,
            solarDeviceCount,
        });
    }
}
