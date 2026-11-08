import {
  isMainFusePhaseCapabilities,
  type MainFusePhaseCapabilities,
} from '../../packages/shared-domain/src/settings/mainFusePhaseSource';
import { MAIN_FUSE_PHASE_CAPABILITIES, MAIN_FUSE_PHASE_METER_DEVICE_ID } from '../utils/settingsKeys';

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
