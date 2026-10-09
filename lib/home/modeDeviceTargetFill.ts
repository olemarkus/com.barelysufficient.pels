import type { SettingsPort } from '../ports/homeyRuntime';
import { getDebugEmitter } from '../logging/logger';
import { MODE_DEVICE_TARGETS, homeScopedSettingsKey, type HomeId } from '../utils/settingsKeys';
import { DEFAULT_MODE_NAME } from '../../packages/shared-domain/src/modeLabels';
import {
  isWritableModeDeviceTargets,
  type ModeDeviceTargets,
} from '../../packages/shared-domain/src/settings/modeDeviceTargets';
import {
  resolveModeTargets,
  type ModeTargetDevice,
} from '../../packages/shared-domain/src/modeCatalogResolution';
import { readModeDeviceTargets } from './modeDeviceTargetsRead';

/**
 * A device the planner plans, with the setpoint PELS holds it at, as the fill
 * pass needs it: the resolver's probe plus the name its log line carries.
 *
 * Projected from the plan device by the caller, because deciding which devices
 * have a setpoint is the planner's own temperature test and `lib/home` may not
 * import the planner (`no-home-to-peer`).
 */
export type ModeTargetFillDevice = ModeTargetDevice & { name: string };

type StructuredEventEmitter = (event: Record<string, unknown>) => void;

type FilledEntry = { mode: string; deviceId: string; targetC: number };

type ModeTargetFillWrite = {
  homeId: HomeId;
  key: string;
  next: ModeDeviceTargets;
  filled: FilledEntry[];
};

const debugStructured = getDebugEmitter('devices', 'devices');

/**
 * Persists the per-mode targets `resolveModeTargets` had to fill.
 *
 * The resolver already answers completely, so nothing downstream depends on
 * this pass having run — a device that appeared a second ago is planned with a
 * resolved target either way. What this adds is durability: PELS owns a managed
 * thermostat's setpoint, and a setpoint that is re-derived from the device on
 * every boot is not owned, it is followed. Writing the first resolution down
 * makes it the owner's target from then on, editable on the Modes screen and
 * stable across a restart (`notes/temperature-ownership.md`).
 *
 * Runs on the snapshot refresh, before the plan cycle, so the write is a
 * deliberate act on the producer's pass rather than a side effect hiding inside
 * a plan build.
 *
 * One instance per app: the record of what it already filled lives on the
 * instance, so it spans every refresh of the process and nothing else.
 */
export class ModeDeviceTargetFill {
  /**
   * (home, mode, device) entries this instance has already filled. Once filled,
   * never re-fill even if the entry goes missing again — otherwise a snapshot
   * refresh would race a user-clear from the settings UI and bring the value
   * straight back. Deliberately not persisted: if the entry is still missing
   * after a restart, the owner has not had a chance to clear it, so filling
   * again is the right call.
   */
  private readonly filledEntries = new Set<string>();

  constructor(
    private readonly settings: SettingsPort,
    /** The planned devices that hold a setpoint, read fresh on every pass. */
    private readonly listDevices: () => readonly ModeTargetFillDevice[],
    /** Committed ownership attribution; `null` while ownership is unsettled skips the device. */
    private readonly resolveHomeIdForDevice: (deviceId: string) => HomeId | null,
    private readonly structuredLog: StructuredEventEmitter,
  ) {}

  persist(): void {
    const devices = this.listDevices();
    if (devices.length === 0) return;

    const byHome = new Map<HomeId, ModeTargetFillDevice[]>();
    devices.forEach((device) => {
      const homeId = this.resolveHomeIdForDevice(device.id);
      if (homeId === null) return;
      byHome.set(homeId, [...(byHome.get(homeId) ?? []), device]);
    });

    const writes = [...byHome].flatMap(([homeId, homeDevices]) => this.planWrite(homeId, homeDevices));
    if (writes.length === 0) return;
    if (writes.some((write) => !isWritableModeDeviceTargets(write.next))) return;

    writes.forEach((write) => {
      this.settings.set(write.key, write.next);
      write.filled.forEach((entry) => {
        this.filledEntries.add(filledEntryFingerprint(write.homeId, entry.mode, entry.deviceId));
      });
      // One line per device, naming the modes it was filled for — a device joining
      // five modes is one fact, not five.
      [...new Set(write.filled.map((entry) => entry.deviceId))].forEach((deviceId) => {
        const entries = write.filled.filter((entry) => entry.deviceId === deviceId);
        this.structuredLog({
          event: 'mode_target_filled',
          deviceId,
          deviceName: devices.find((device) => device.id === deviceId)?.name,
          filledModes: entries.map((entry) => entry.mode),
          targetC: entries[0]?.targetC,
        });
      });
    });
    debugStructured({
      event: 'mode_targets_persisted',
      entryCount: writes.reduce((sum, write) => sum + write.filled.length, 0),
    });
  }

  /** The catalog one home would hold with its missing entries filled, or nothing to write. */
  private planWrite(homeId: HomeId, devices: readonly ModeTargetFillDevice[]): ModeTargetFillWrite[] {
    const key = homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId);
    const read = readModeDeviceTargets(this.settings, key);
    // Read failed, or the payload is not something the owner recognizes: decide
    // nothing, retry next refresh, and never write over it.
    if (read.state === 'unavailable') return [];
    // Every mode the home has, so switching modes never lands on a blank. A
    // home whose catalog has never been written starts at the default mode —
    // Main's blob is only ever written by the settings UI, so an owner who
    // never opened the Modes screen had none at all while PELS planned, shed,
    // and auto-assigned a `set_temperature` shed to their heaters.
    const modes = Object.keys(read.catalog).length === 0
      ? [DEFAULT_MODE_NAME]
      : Object.keys(read.catalog);
    const filled = modes.flatMap((mode) => {
      const resolved = resolveModeTargets({
        targetCFor: (deviceId) => read.catalog[mode]?.[deviceId],
        devices,
      });
      return Object.entries(resolved.unstoredTargetsByDeviceId)
        // Once filled by this instance, never re-fill: otherwise this pass would
        // race a user-clear on the Modes screen and bring the value back.
        .filter(([deviceId]) => !this.filledEntries.has(filledEntryFingerprint(homeId, mode, deviceId)))
        .map(([deviceId, targetC]) => ({ mode, deviceId, targetC }));
    });
    if (filled.length === 0) return [];
    const next: ModeDeviceTargets = Object.fromEntries([
      ...Object.entries(read.catalog),
      ...modes.map((mode) => [mode, {
        ...(read.catalog[mode] ?? {}),
        ...Object.fromEntries(filled.filter((f) => f.mode === mode).map((f) => [f.deviceId, f.targetC])),
      }] as const),
    ]);
    return [{ homeId, key, next, filled }];
  }
}

const filledEntryFingerprint = (homeId: HomeId, mode: string, deviceId: string): string =>
  `${homeId}::${mode}::${deviceId}`;
