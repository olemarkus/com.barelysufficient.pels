/**
 * The observation producers a snapshot refresh feeds: the battery and solar
 * role producers before the parse, and the EV car-link probe after the commit.
 */
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceListRead } from '../deviceListRead';
import type { BatteryStateProducer } from '../batteryStateProducer';
import type { SolarProductionProducer } from '../solarProductionProducer';
import type { EvCarLinkProducer } from '../evCarLinkProducer';
import type { DeviceFetchSource } from './managerFetch';

/**
 * Run the EV car-link probe after the snapshot commit, then re-sync the realtime
 * subscription set.
 *
 * Both halves have to happen here. The probe resolves charger state from the
 * COMMITTED snapshot, so it cannot run pre-parse with the battery/solar
 * producers. And the commit built the subscription list before the probe had
 * learned which cars exist — per-device capability subscriptions are the only
 * realtime source of capability VALUE changes, and a class `car` device never
 * survives parse, so without this re-sync a newly-seen car stays unsubscribed
 * until the next fetch: half an hour of blindness at every boot.
 */
export function observeEvCarLinkAndResubscribe(
    evCarLink: EvCarLinkProducer,
    updateLiveFeedTrackedDevices: (deviceIds: string[]) => void,
    read: DeviceListRead,
    fetchSource: DeviceFetchSource,
    snapshot: readonly TargetDeviceSnapshot[],
): void {
    evCarLink.observe(read, {
        fullRefresh: fetchSource === 'raw_manager_devices',
        nowMs: Date.now(),
    });
    updateLiveFeedTrackedDevices([
        ...snapshot.map((device) => device.id),
        ...evCarLink.getObservedCarDeviceIds(),
    ]);
}

// Detect home batteries and solar devices from the RAW fetched devices BEFORE
// parse, then pass the list through unchanged. Ordering matters: parse routes
// `getManaged`/`getControllable` (→ the app's role-aware resolve functions,
// `lib/device/deviceRoleReads.ts`) which consult these same id sets, so they must be
// current first. A role-detected solar device resolves managed; a battery resolves
// its Managed toggle, and both resolve non-controllable and ride the runtime
// snapshot whatever their Managed state; it also emits the read-only
// `battery_state_observed` / `solar_production_observed` events. A FULL read
// (`raw_manager_devices`) re-derives the sets; a targeted by-id read re-reads the
// SAME known ids and must not narrow them.
export function observeBatteryStateFromList(
    battery: BatteryStateProducer,
    solar: SolarProductionProducer,
    read: DeviceListRead,
    fetchSource: DeviceFetchSource,
): HomeyDeviceLike[] {
    const fullRefresh = fetchSource === 'raw_manager_devices';
    battery.observe(read, { fullRefresh });
    solar.observe(read, { fullRefresh });
    // The EV car-link probe is deliberately NOT observed here — it runs after the
    // snapshot commit (see `refreshSnapshot`), because it resolves charger state
    // from the committed snapshot. Observing it here as well would give it one
    // pass against the PREVIOUS charger state, which can emit and persist a false
    // self-stop on the very refresh where the dwell expires.
    return read.devices;
}
