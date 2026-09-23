import type { HomeyDeviceLike } from '../utils/types';

/**
 * One fetched device list after the device-read contract
 * (`transport/deviceReadContract.ts`): the reads that conform, and the ids of
 * the devices that were present in the fetch but whose read is ignored.
 *
 * Both halves are facts about the fetch. An ignored device is PRESENT — the
 * fetch listed it, so a consumer that tracks membership must neither drop it
 * nor count it as missed — and UNREAD: none of its values reach a consumer. A
 * consumer given only the conforming devices would read an ignored device's
 * absence as its removal, which is exactly the state change an ignored read
 * must not make.
 */
export type DeviceListRead = {
    devices: HomeyDeviceLike[];
    ignoredIds: ReadonlySet<string>;
};
