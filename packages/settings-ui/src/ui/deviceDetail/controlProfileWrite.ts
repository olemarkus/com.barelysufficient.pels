import type {
  DeviceControlProfiles,
  SteppedLoadProfile,
} from '../../../../contracts/src/types.ts';
import {
  normalizeDeviceControlProfile,
  normalizeDeviceControlProfiles,
} from '../../../../contracts/src/deviceControlProfiles.ts';
import { DEVICE_CONTROL_PROFILES } from '../../../../contracts/src/settingsKeys.ts';
import { applyLocalDeviceControlProfile } from '../deviceControlProfiles.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

const runSerializedDeviceControlProfileWrite = createSerializedAsyncRunner();

export type PersistDeviceControlProfileParams = {
  deviceId: string;
  profile: SteppedLoadProfile | null;
  onCommitted: (deviceId: string) => void;
  onRolledBack: (deviceId: string) => void;
};

/**
 * The single write boundary for `device_control_profiles`.
 *
 * Every caller passes a profile it believes is good — the editor's normalized
 * draft, or the ladder generated when the owner switches to stepped control —
 * so the guard here is about the class of bug rather than any caller in
 * particular: nothing may persist a ladder with no step the device can run at,
 * because PELS would then own a device it can pause and never resume. Refusing
 * the write leaves the previous profile in place; the caller reports the
 * failure.
 *
 * What lands is the NORMALIZED profile, not the caller's. The normalizer is not
 * only a yes/no gate: it also sorts the rungs and drops malformed steps and
 * non-finite optional fields, so writing the input back would let exactly the
 * values it rejected reach persisted settings and local state.
 */
export const persistDeviceControlProfile = async (
  params: PersistDeviceControlProfileParams,
): Promise<boolean> => {
  const { deviceId, profile: requestedProfile } = params;
  const profile = requestedProfile ? normalizeDeviceControlProfile(requestedProfile) : null;
  if (requestedProfile && !profile) {
    await showToastError(
      new Error('This profile has no step the device can run at, so it would never resume.'),
      'Failed to save device control profile.',
    );
    return false;
  }
  return runSerializedDeviceControlProfileWrite(async () => {
    let didPersist = false;
    await writeFreshSetting<DeviceControlProfiles>({
      key: DEVICE_CONTROL_PROFILES,
      context: 'device detail',
      logMessage: 'Failed to save device control profile',
      toastMessage: 'Failed to save device control profile.',
      // Use the live in-memory profiles map as the snapshot fallback so
      // that a transient null SDK read does not erase profiles for other
      // devices. The first-write case is still safe: when no profiles
      // exist locally either, the merged write is the user's new entry
      // alone.
      fallbackValue: state.deviceControlProfiles,
      // Only normalize when the fresh SDK value is a real object.
      // Anything else returns null so `writeFreshSetting` falls back to
      // the snapshot instead of normalising garbage into `{}`.
      readFresh: (value) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? normalizeDeviceControlProfiles(value)
          : null
      ),
      mutate: (currentProfiles) => {
        const nextProfiles = { ...currentProfiles };
        if (profile) {
          nextProfiles[deviceId] = profile;
        } else {
          delete nextProfiles[deviceId];
        }
        return nextProfiles;
      },
      commit: (nextProfiles) => {
        state.deviceControlProfiles = nextProfiles;
        applyLocalDeviceControlProfile(deviceId, profile);
        params.onCommitted(deviceId);
        didPersist = true;
      },
      rollback: () => params.onRolledBack(deviceId),
    });
    return didPersist;
  });
};
