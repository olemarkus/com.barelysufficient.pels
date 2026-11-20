import {
  isMainFusePhaseCapabilities,
  type MainFusePhaseCapabilities,
} from '../../packages/shared-domain/src/settings/mainFusePhaseSource';
import { MAIN_FUSE_PHASE_CAPABILITIES, MAIN_FUSE_PHASE_METER_DEVICE_ID } from '../utils/settingsKeys';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { PowerSource } from '../ports/configuredPowerSource';

export type MainFusePhaseSource = {
  /** The owner's choice of capability per phase; null lets PELS recognise them. */
  capabilities: MainFusePhaseCapabilities | null;
  /** A meter device the owner picked for a Flow-source home; null when none. */
  meterDeviceId: string | null;
};

/** Where the phases come from, as the owner set it. A malformed value is no choice. */
export function readMainFusePhaseSource(settings: { get(key: string): unknown }): MainFusePhaseSource {
  const capabilities = settings.get(MAIN_FUSE_PHASE_CAPABILITIES);
  const meterDeviceId = settings.get(MAIN_FUSE_PHASE_METER_DEVICE_ID);
  return {
    capabilities: isMainFusePhaseCapabilities(capabilities) ? capabilities : null,
    meterDeviceId: typeof meterDeviceId === 'string' && meterDeviceId !== '' ? meterDeviceId : null,
  };
}

/** The configured source of a phase observation, including the meaning of L1–L3. */
export type PhaseMeter = {
  readonly powerSource: PowerSource;
  readonly meterDeviceId: string;
  readonly capabilities: MainFusePhaseCapabilities | null;
};

export function resolvePhaseMeter(
  phaseSource: MainFusePhaseSource,
  powerSource: PowerSource,
  readMainMeter: () => MainMeterSelection,
): PhaseMeter | null {
  if (powerSource === 'flow') {
    const { meterDeviceId, capabilities } = phaseSource;
    return meterDeviceId === null ? null : { powerSource, meterDeviceId, capabilities };
  }
  const mainMeter = readMainMeter();
  return mainMeter.state === 'resolved'
    ? { powerSource, meterDeviceId: mainMeter.meterDeviceId, capabilities: phaseSource.capabilities }
    : null;
}

export function isSamePhaseMeter(a: PhaseMeter | null, b: PhaseMeter | null): boolean {
  if (a === null || b === null) return false;
  return a.powerSource === b.powerSource
    && a.meterDeviceId === b.meterDeviceId
    && samePhaseCapabilities(a.capabilities, b.capabilities);
}

function samePhaseCapabilities(a: MainFusePhaseCapabilities | null, b: MainFusePhaseCapabilities | null): boolean {
  if (a === null || b === null) return a === b;
  return a.facet === b.facet && a.L1 === b.L1 && a.L2 === b.L2 && a.L3 === b.L3;
}
