import {
  readCarAssociationCandidatesFromHomey,
  readChargerPhasePresetsFromHomey,
  SettingsUiDeviceReads,
} from '../../lib/device/settingsUiDeviceReads';

describe('SettingsUiDeviceReads', () => {
  it('keeps an unwired transport behind tagged unavailable reads', () => {
    const reads = new SettingsUiDeviceReads();

    expect(reads.readChargerPhasePresets()).toEqual({ state: 'unavailable' });
    expect(reads.readCarAssociationCandidates()).toEqual({ state: 'unavailable' });
  });

  it('delegates to the wired tagged-read producer without reclassifying its result', () => {
    const chargerRead = { state: 'resolved' as const, presets: { 'charger-1': 'ev_charger_3_phase' as const } };
    const carRead = { state: 'resolved' as const, cars: [{ id: 'car-1', name: 'Polestar 3' }] };
    const reads = new SettingsUiDeviceReads();
    reads.connect({
      readChargerPhasePresets: () => chargerRead,
      readCarAssociationCandidates: () => carRead,
    });

    expect(reads.readChargerPhasePresets()).toBe(chargerRead);
    expect(reads.readCarAssociationCandidates()).toBe(carRead);

    reads.disconnect();
    expect(reads.readChargerPhasePresets()).toEqual({ state: 'unavailable' });
  });
});

describe('Homey settings-UI device-read boundary', () => {
  it('resolves missing and malformed app shells without leaking unknown inward', () => {
    expect(readChargerPhasePresetsFromHomey({})).toEqual({ state: 'unavailable' });
    expect(readCarAssociationCandidatesFromHomey({ app: 'starting' })).toEqual({ state: 'unavailable' });
  });

  it('delegates each read independently from the Homey app shell', () => {
    const chargerRead = { state: 'resolved' as const, presets: {} };
    const carRead = { state: 'resolved' as const, cars: [] };
    const reads = new SettingsUiDeviceReads();
    reads.connect({
      readChargerPhasePresets: () => chargerRead,
      readCarAssociationCandidates: () => carRead,
    });

    expect(readChargerPhasePresetsFromHomey({
      app: { settingsUiDeviceReads: reads },
    })).toBe(chargerRead);
    expect(readCarAssociationCandidatesFromHomey({
      app: { settingsUiDeviceReads: reads },
    })).toBe(carRead);
  });
});
