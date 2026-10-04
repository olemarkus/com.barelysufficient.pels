import {
  readCarAssociationCandidatesFromHomey,
  readChargerPhasePresetsFromHomey,
  resolveCarAssociationCandidatesRead,
  SettingsUiDeviceReads,
} from '../../lib/device/settingsUiDeviceReads';
import type { EvCarLinkProducer } from '../../lib/device/evCarLinkProducer';
import type { EvCarChargerMatchHistory } from '../../packages/contracts/src/evCarLink';
import type { HomeyDeviceLike } from '../../lib/utils/types';

describe('SettingsUiDeviceReads', () => {
  it('keeps an unwired transport behind tagged unavailable reads', () => {
    const reads = new SettingsUiDeviceReads();

    expect(reads.readChargerPhasePresets()).toEqual({ state: 'unavailable' });
    expect(reads.readCarAssociationCandidates()).toEqual({ state: 'unavailable' });
  });

  it('delegates to the wired tagged-read producer without reclassifying its result', () => {
    const chargerRead = { state: 'resolved' as const, presets: { 'charger-1': 'ev_charger_3_phase' as const } };
    const carRead = { state: 'resolved' as const, cars: [{
      id: 'car-1',
      name: 'Polestar 3',
      matchHistory: { state: 'resolved' as const, chargerMatches: [] },
    }] };
    const reads = new SettingsUiDeviceReads();
    reads.connect({
      readChargerPhasePresets: () => chargerRead,
      readCarAssociationCandidates: () => carRead,
      getUiPickerDevices: () => [],
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
      getUiPickerDevices: () => [],
    });

    expect(readChargerPhasePresetsFromHomey({
      app: { settingsUiDeviceReads: reads },
    })).toBe(chargerRead);
    expect(readCarAssociationCandidatesFromHomey({
      app: { settingsUiDeviceReads: reads },
    })).toBe(carRead);
  });
});

describe('resolveCarAssociationCandidatesRead', () => {
  const car = {
    id: 'car-1',
    name: 'Kia EV6',
    class: 'vehicle',
    capabilities: ['ev_charging_state', 'measure_battery'],
  } as unknown as HomeyDeviceLike;

  const producerReading = (history: EvCarChargerMatchHistory) => {
    const readChargerMatchesForCar = vi.fn(() => history);
    // Only the history read is exercised; the producer's correlation is not.
    return { readChargerMatchesForCar, producer: { readChargerMatchesForCar } as unknown as EvCarLinkProducer };
  };

  it('adds each candidate\'s match history from the link producer', () => {
    const history = {
      state: 'resolved' as const,
      chargerMatches: [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }],
    };
    const { readChargerMatchesForCar, producer } = producerReading(history);

    expect(resolveCarAssociationCandidatesRead(true, [car], producer)).toEqual({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Kia EV6', matchHistory: history }],
    });
    expect(readChargerMatchesForCar).toHaveBeenCalledWith('car-1');
  });

  it('passes an unreadable history through rather than calling it no matches', () => {
    const { producer } = producerReading({ state: 'unavailable' });

    expect(resolveCarAssociationCandidatesRead(true, [car], producer)).toEqual({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Kia EV6', matchHistory: { state: 'unavailable' } }],
    });
  });

  it('never reads link history for a home without cars or before the first trusted read', () => {
    const { readChargerMatchesForCar, producer } = producerReading({ state: 'resolved', chargerMatches: [] });

    expect(resolveCarAssociationCandidatesRead(true, [], producer)).toEqual({ state: 'resolved', cars: [] });
    expect(resolveCarAssociationCandidatesRead(false, [car], producer)).toEqual({ state: 'unavailable' });
    expect(readChargerMatchesForCar).not.toHaveBeenCalled();
  });
});
