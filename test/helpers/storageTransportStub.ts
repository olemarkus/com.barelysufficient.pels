import type { ActuatorTransport } from '../../lib/actuator/deviceCommand';

/**
 * The home-battery half of an `ActuatorTransport` double, for specs with no
 * battery. A storage intent reaching it is a bug in the spec's scenario, so it
 * rejects rather than reporting a write that never happened.
 */
export const noStorageTransport: Pick<ActuatorTransport, 'requestStoragePower' | 'releaseStorageControl'> = {
  requestStoragePower: (command) => Promise.reject(new Error(`No home battery in this spec: ${command.deviceId}`)),
  releaseStorageControl: (command) => Promise.reject(new Error(`No home battery in this spec: ${command.deviceId}`)),
};
