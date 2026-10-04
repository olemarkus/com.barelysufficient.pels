import type {
    ChargerPhasePresetsRead,
    SettingsUiRecommendationCarsRead,
} from '../../packages/contracts/src/settingsUiApi';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceSurfaces } from './deviceSurfaces';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { resolveChargerPhasePresets } from './chargerPhasePreset';
import type { EvCarLinkProducer } from './evCarLinkProducer';
import { resolveCarAssociationCandidates } from './evCarLinkObservation';
import { projectDeviceSurfaces } from './deviceSurfaces';

export { resolveChargerPhasePresets };

export const resolveChargerPhasePresetsRead = (
    snapshotWarm: boolean,
    devices: readonly HomeyDeviceLike[],
): ChargerPhasePresetsRead => (
    snapshotWarm
        ? { state: 'resolved', presets: resolveChargerPhasePresets(devices) }
        : { state: 'unavailable' }
);

/**
 * Each candidate carries the chargers the probe has matched it to. The link
 * history is read per candidate, so a home with no cars never touches the
 * lazily loaded link store.
 */
export const resolveCarAssociationCandidatesRead = (
    snapshotWarm: boolean,
    devices: readonly HomeyDeviceLike[],
    evCarLink: EvCarLinkProducer,
): SettingsUiRecommendationCarsRead => (
    snapshotWarm
        ? {
            state: 'resolved',
            cars: resolveCarAssociationCandidates(devices).map((car) => ({
                ...car,
                matchHistory: evCarLink.readChargerMatchesForCar(car.id),
            })),
        }
        : { state: 'unavailable' }
);

/** Trusted tagged metadata reads supplied by the live device transport. */
export type SettingsUiDeviceReadSource = {
  readChargerPhasePresets: () => ChargerPhasePresetsRead;
  readCarAssociationCandidates: () => SettingsUiRecommendationCarsRead;
  getUiPickerDevices: () => TransportDeviceSnapshot[];
};

type SettingsUiDeviceReadSourceState =
    | { state: 'unavailable' }
    | { state: 'resolved'; source: SettingsUiDeviceReadSource };

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null
);

const resolveHomeyApp = (homey: unknown): unknown => (
    isRecord(homey) ? homey.app : undefined
);

const hasSettingsUiDeviceReads = (
    value: unknown,
): value is { settingsUiDeviceReads: SettingsUiDeviceReads } => (
    isRecord(value)
    && value.settingsUiDeviceReads instanceof SettingsUiDeviceReads
);

/**
 * Device-owned producer for tagged settings-UI metadata reads. It exists for
 * the full app lifecycle; wiring connects the trusted transport once startup
 * reaches it and disconnects it during teardown. Consumers therefore receive
 * a semantic result without observing an optional service handle.
 */
export class SettingsUiDeviceReads {
    private sourceState: SettingsUiDeviceReadSourceState = { state: 'unavailable' };

    connect(source: SettingsUiDeviceReadSource): void {
        this.sourceState = { state: 'resolved', source };
    }

    disconnect(): void {
        this.sourceState = { state: 'unavailable' };
    }

    readChargerPhasePresets(): ChargerPhasePresetsRead {
        return this.sourceState.state === 'resolved'
            ? this.sourceState.source.readChargerPhasePresets()
            : { state: 'unavailable' };
    }

  readCarAssociationCandidates(): SettingsUiRecommendationCarsRead {
        return this.sourceState.state === 'resolved'
            ? this.sourceState.source.readCarAssociationCandidates()
            : { state: 'unavailable' };
  }

  getUiPickerDevices(): DeviceSurfaces[] {
    return this.sourceState.state === 'resolved'
      ? projectDeviceSurfaces(this.sourceState.source.getUiPickerDevices())
      : [];
  }

}

/** Resolve the untrusted Homey app shell at the device-owned read boundary. */
export const readChargerPhasePresetsFromHomey = (homey: unknown): ChargerPhasePresetsRead => {
    const app = resolveHomeyApp(homey);
    return hasSettingsUiDeviceReads(app)
        ? app.settingsUiDeviceReads.readChargerPhasePresets()
        : { state: 'unavailable' };
};

/** Resolve the untrusted Homey app shell at the device-owned read boundary. */
export const readCarAssociationCandidatesFromHomey = (homey: unknown): SettingsUiRecommendationCarsRead => {
    const app = resolveHomeyApp(homey);
    return hasSettingsUiDeviceReads(app)
        ? app.settingsUiDeviceReads.readCarAssociationCandidates()
        : { state: 'unavailable' };
};
