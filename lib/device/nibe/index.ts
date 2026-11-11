import type { CapabilityWrite, DeviceAdapter } from '../deviceAdapter';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// NIBE heat pumps on the official myUplink app (`com.nibe.myuplink` 1.9.2,
// `notes/native-wiring/nibe.md`). Both drivers keep the room setpoint in
// `target_temperature.room` and the room reading (BT50 or the controlling
// zone) in `measure_temperature.room`, and declare no plain temperature pair.
// PELS accepts that pair as the pump's `target_temperature` and
// `measure_temperature`, and writes the setpoint back to
// `target_temperature.room`. A pump without a room reading declares no
// `measure_temperature.room`; its read is accepted as Homey reports it.
const NIBE_DRIVER_IDS: ReadonlySet<string> = new Set([
  'homey:app:com.nibe.myuplink:heatpump',
  'homey:app:com.nibe.myuplink:s-series',
]);

const ROOM_TARGET = 'target_temperature.room';
const ROOM_MEASURE = 'measure_temperature.room';
const TARGET = 'target_temperature';
const MEASURE = 'measure_temperature';
/** Vendor capability → the standard one PELS reads it as. */
const STANDARD_BY_VENDOR: Readonly<Record<string, string>> = { [ROOM_TARGET]: TARGET, [ROOM_MEASURE]: MEASURE };

const isNibePump = (device: HomeyDeviceLike): boolean => NIBE_DRIVER_IDS.has(device.driverId);

/** The vendor pair is read as the standard one only when the app declares both halves and no standard pair. */
const declaresRoomPair = (device: HomeyDeviceLike): boolean => device.capabilities.includes(ROOM_TARGET)
  && device.capabilities.includes(ROOM_MEASURE)
  && !device.capabilities.includes(TARGET) && !device.capabilities.includes(MEASURE);

/**
 * An accepted read the room pair was projected onto: the standard pair is
 * there and the vendor ids are gone. An app that declares its own plain pair
 * beside the room pair keeps both, and is read and written as declared.
 */
const readsRoomPair = (device: HomeyDeviceLike): boolean => device.capabilities.includes(TARGET)
  && device.capabilities.includes(MEASURE)
  && !device.capabilities.includes(ROOM_TARGET) && !device.capabilities.includes(ROOM_MEASURE);

function projectRoomPair(device: HomeyDeviceLike): HomeyDeviceLike {
  if (!declaresRoomPair(device)) return device;
  const capabilitiesObj = Object.fromEntries(Object.entries(device.capabilitiesObj).map(([capabilityId, entry]) => {
    const standard = STANDARD_BY_VENDOR[capabilityId];
    if (standard === undefined || entry === undefined) return [capabilityId, entry];
    return [standard, { ...entry, id: standard }];
  }));
  return {
    ...device,
    capabilities: device.capabilities.map((capabilityId) => STANDARD_BY_VENDOR[capabilityId] ?? capabilityId),
    capabilitiesObj,
  };
}

const reportedRoomCapabilityId = (device: HomeyDeviceLike, capabilityId: string): string => (
  readsRoomPair(device) ? STANDARD_BY_VENDOR[capabilityId] ?? capabilityId : capabilityId
);

const writeRoomSetpoint = (device: HomeyDeviceLike, request: CapabilityWrite): CapabilityWrite => (
  request.capabilityId === TARGET && readsRoomPair(device) ? { ...request, capabilityId: ROOM_TARGET } : request
);

export const nibeMyUplinkAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isNibePump,
  projectRead: (device) => [projectRoomPair(device)],
  routeReport: (device, capabilityId) => ({
    deviceId: device.id, capabilityId: reportedRoomCapabilityId(device, capabilityId),
  }),
  capabilityWrite: writeRoomSetpoint,
};
