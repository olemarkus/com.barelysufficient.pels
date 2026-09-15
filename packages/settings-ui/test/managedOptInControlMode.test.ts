import { resolveManagedOptInControlMode } from '../src/ui/deviceDetail/targetPowerConfig.ts';
import { state } from '../src/ui/state.ts';
import { createEvTargetPowerConfig } from '../../shared-domain/src/evTargetPowerConfig.ts';

type OptInDevice = Parameters<typeof resolveManagedOptInControlMode>[0];

const charger = (overrides: Partial<OptInDevice> = {}): OptInDevice => ({
  id: 'easee-1',
  ...overrides,
} as OptInDevice);

describe('resolveManagedOptInControlMode', () => {
  beforeEach(() => {
    state.chargerPhasePresets = { 'easee-1': 'ev_charger_1_phase' };
    state.deviceTargetPowerConfigs = {};
    state.deviceControlProfiles = {};
  });

  it('saves the EV preset the charger reports for a charger with no control mode', () => {
    expect(resolveManagedOptInControlMode(charger())).toEqual({
      kind: 'save_charger_preset',
      config: createEvTargetPowerConfig('ev_charger_1_phase'),
    });
  });

  it('leaves the mode alone when the charger reports no wiring', () => {
    state.chargerPhasePresets = {};
    expect(resolveManagedOptInControlMode(charger())).toEqual({ kind: 'leave' });
  });

  it('leaves a saved control mode alone, including one set for a single-phase car', () => {
    // The Flow card or the owner picked 1-phase on a charger wired for three.
    state.chargerPhasePresets = { 'easee-1': 'ev_charger_3_phase' };
    state.deviceTargetPowerConfigs = { 'easee-1': createEvTargetPowerConfig('ev_charger_1_phase') };
    expect(resolveManagedOptInControlMode(charger())).toEqual({ kind: 'leave' });

    state.deviceTargetPowerConfigs = { 'easee-1': { enabled: false } };
    expect(resolveManagedOptInControlMode(charger())).toEqual({ kind: 'leave' });
  });

  it('leaves a stepped profile or a producer-resolved control model alone', () => {
    state.deviceControlProfiles = { 'easee-1': { steps: [{ id: 'off', planningPowerW: 0 }, { id: 'on', planningPowerW: 3_680 }] } };
    expect(resolveManagedOptInControlMode(charger())).toEqual({ kind: 'leave' });

    state.deviceControlProfiles = {};
    expect(resolveManagedOptInControlMode(charger({ controlModel: 'stepped_load' }))).toEqual({ kind: 'leave' });
  });
});
