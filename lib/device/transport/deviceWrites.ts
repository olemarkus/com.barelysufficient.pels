import { resolveCommandableNow } from '../../../packages/shared-domain/src/commandableNow';
import type { ChargingCurrentControl } from '../chargingCurrentControl';
import type { HomeBatteryAppActions } from '../homeBatteryAppActions';
import type { EvChargingCurrentLimitPolicy } from '../evChargingCurrentLimitPolicy';
import { resolveChargingCurrentAdapter } from '../chargingCurrentAdapter';
/**
 * Device write service for `DeviceTransport`. Applies capability writes without
 * fabricating observed truth, plus target batches, previews, and stepped-load
 * step requests. The actual SDK write lands in
 * `managerHomeyApi.setRawCapabilityValue`, which already takes plain data.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import type { SteppedLoadWrite, SteppedLoadStepRequestResult } from '../../ports/steppedLoadWrite';
import type { StoragePowerCommand, StoragePowerWrite, StorageReleaseCommand } from '../../ports/storageCommand';
import type { HomeBatteryControlSurface } from '../../../packages/contracts/src/types';
import type { InverterControlBinding, InverterControlSurface } from '../../../packages/contracts/src/inverterControl';
import { getDebugEmitter } from '../../logging/logger';
import { incPerfCounter } from '../../utils/perfCounters';
import { normalizeError } from '../../utils/errorUtils';
import { resolveHomeyHttpStatusCode } from '../../utils/homeyHttpStatusError';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import { isSteppedLoadOffStep } from '../../../packages/shared-domain/src/deviceControlProfiles';
import { logEvCapabilityAccepted, logEvCapabilityRequest } from '../managerControl';
import { hasRestClient, setRawCapabilityValue } from './managerHomeyApi';
import { recordLocalWriteObservation } from './managerObservation';
import { isNativeSteppedLoadControlEnabled, type CapabilityWrite } from '../nativeSteppedLoadWiring';
import { getDeviceAdapter, getSnapshotAdapter } from '../deviceAdapterRegistry';
import type { HomeBatteryCapabilityBinding, SessionEvidence, SwitchWrite } from '../deviceAdapter';
import type { SteppedLoadFlowTriggerCard } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../utils/types';
import type { Logger } from '../../utils/types';
import type { ObservationProducers } from '../observationProducers';
import { isCanSetControl } from '../deviceActionProjection';
import {
  HOME_BATTERY_SETPOINT_CAPABILITY_ID,
  meterModeFor,
  toBatterySetpointCapabilityValue,
  toTargetPowerCapabilityValue,
} from '../batteryControlWiring';
import { isHomeBatterySnapshot } from './homeBatteryObservation';
import { TransportSnapshotStore } from './transportSnapshotStore';
import type { NativeWiringRead } from './managerParseDevice';
import { TransportObservationState } from './transportObservationState';
import { resolveInverterControl } from './solarInverterObservation';
import { inverterBindingsMatch, inverterRestorationLimitW } from '../../planContract/inverterDecision';

const emitTransportDebug = getDebugEmitter('devices', 'devices');
const FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS = 10_000;

function normalizeCapabilityValue(
    snapshotStore: TransportSnapshotStore,
    deviceId: string,
    capabilityId: string,
    value: unknown,
): unknown {
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    const snapshot = snapshotStore.getSnapshotByDeviceId(deviceId);
    const target = snapshot?.targets.find((entry) => entry.id === capabilityId);
    if (!target) return value;
    return normalizeTargetCapabilityValue({ target, value });
}

function emitCapabilityWriteDebug(
    event: 'device_capability_write_requested' | 'device_capability_write_accepted',
    deviceId: string,
    capabilityId: string,
    value: unknown,
    write: CapabilityWrite,
): void {
    emitTransportDebug({
        event,
        deviceId,
        capabilityId,
        writeCapabilityId: write.capabilityId,
        value,
        valueType: typeof value,
        writeValue: write.value,
    });
}

/**
 * Where a write to a device's binary switch lands in the SDK: the switch, or the
 * capability the transport routes it to. An Easee may carry out its charging
 * switch through the charger current instead (`resolveEaseeSwitchWrite`).
 * The settle evidence PELS waits for stays on the switch it asked for, and only
 * the switch is recorded as PELS's own write: an Easee current's echo is always an
 * observation (`nativeSteppedRealtime.ts`). An Easee under built-in control reads
 * its switch from the plug state and the current, not from what Homey holds for
 * it, so PELS's own write to the switch is no observation of it either. A
 * request the device needs no command for (an Easee session the car completed,
 * with built-in control off) sends nothing.
 */
function resolveSwitchSdkWrite(
    snapshot: TransportDeviceSnapshot,
    trackedDevice: HomeyDeviceLike | undefined,
    requested: CapabilityWrite,
    sessions: SessionEvidence,
): SwitchWrite {
    return trackedDevice
        ? getDeviceAdapter(trackedDevice).recoverSwitchWrite(snapshot, trackedDevice, requested, sessions)
        : getSnapshotAdapter(snapshot).switchWrite(snapshot, requested, sessions);
}

/** A non-switch write, under the capability the device's integration writes it to. */
function resolveCapabilitySdkWrite(
    trackedDevice: HomeyDeviceLike | undefined,
    requested: CapabilityWrite,
): CapabilityWrite {
    return trackedDevice ? getDeviceAdapter(trackedDevice).capabilityWrite(trackedDevice, requested) : requested;
}

type DrivableSurface =Extract<HomeBatteryControlSurface, { kind: 'setpoint' } | { kind: 'app_actions' }>;

/**
 * The surface a storage intent's writes are resolved from: a setpoint
 * surface, or the app's actions. A device that is not a home battery, or one
 * PELS can only observe, has no storage binding: the intent is refused, never
 * improvised.
 */
function requireDrivableSurface(snapshot: TransportDeviceSnapshot | undefined, deviceId: string): DrivableSurface {
    if (snapshot === undefined || !isHomeBatterySnapshot(snapshot)) {
        throw new Error(`No home battery binding for device ${deviceId}`);
    }
    const surface = snapshot.homeBattery.controlSurface;
    if (surface.kind === 'observe_only') {
        throw new Error(`Home battery ${deviceId} is observe-only (${surface.reason})`);
    }
    return surface;
}

/**
 * The battery's binding, from its integration, read off the raw device the
 * surface was parsed from. A home battery is always tracked
 * (`isRuntimeTrackedDevice`), so a missing raw read is metadata lost, and the
 * intent is refused rather than written in a sign nobody resolved.
 */
function requireHomeBatteryBinding(
    snapshotStore: TransportSnapshotStore,
    deviceId: string,
): HomeBatteryCapabilityBinding {
    const raw = snapshotStore.getTrackedRawDevice(deviceId);
    if (raw === undefined) throw new Error(`Home battery ${deviceId} control metadata is unavailable`);
    const binding = getDeviceAdapter(raw).homeBatteryBinding(raw);
    if (binding.kind !== 'capability') throw new Error(`Home battery ${deviceId} control binding changed`);
    return binding;
}

export class DeviceWriteService {
  // eslint-disable-next-line max-params -- Direct transport owners and dispatch ports, not a parameter bundle.
  constructor(
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly observationState: TransportObservationState,
    private readonly logger: Logger,
    private readonly chargingCurrentControl: ChargingCurrentControl,
    private readonly batteryAppActions: HomeBatteryAppActions,
    private readonly nativeWiring: NativeWiringRead,
    private readonly currentLimitPolicy: EvChargingCurrentLimitPolicy,
    private readonly observationProducers: ObservationProducers,
    private readonly getFlowTriggerCard: (cardId: string) => SteppedLoadFlowTriggerCard | undefined,
    private readonly dispatchObservedStateForDevice: (deviceId: string, capabilityId?: string) => void,
  ) {}

  private requiresAdapterControl(deviceId: string): boolean {
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    return snapshot !== undefined && this.chargingCurrentControl.sessions.controls(snapshot);
  }

  private assertControlAllowed(deviceId: string): HomeyDeviceLike | undefined {
    const raw = this.snapshotStore.getTrackedRawDevice(deviceId);
    if (!raw && this.requiresAdapterControl(deviceId)) {
      throw new Error('Device control metadata is unavailable.');
    }
    if (raw) this.chargingCurrentControl.assertControlAllowed(raw);
    return raw;
  }

  /** Actuator preflight, resolved against the current transport snapshot. */
  canTurnOnDevice(deviceId: string): boolean {
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    return snapshot !== undefined
      && snapshot.available !== false
      && isCanSetControl(snapshot)
      && snapshot.binaryControlObservation !== undefined
      && resolveCommandableNow(snapshot)
      && !this.needsNativeControlReadBeforeStart(snapshot);
  }

  /**
   * Missing native observations cannot turn a stepped start into a binary-only
   * start. The device is judged as it is parsed, without the capabilities an
   * integration session withholds: a Zaptec on a shared installation keeps
   * declaring `target_power`, which PELS then never writes, and its app sets no
   * value there by itself, so waiting for one would leave the charger off.
   */
  private needsNativeControlReadBeforeStart(snapshot: TransportDeviceSnapshot): boolean {
    const tracked = this.snapshotStore.getTrackedRawDevice(snapshot.id);
    if (!tracked) return false;
    const raw = this.chargingCurrentControl.sessions.withholdCapabilities(tracked);
    if (this.needsNativeWattReadBeforeStart(raw)) return true;
    if (!this.nativeWiring.resolveNativeWiringEnabled(snapshot.id)) return false;
    return getDeviceAdapter(raw).nativeCurrentControls.some(control => {
      const current = raw.capabilitiesObj[control.capabilityId];
      if (!raw.capabilities.includes(control.capabilityId) || current?.setable === false) return false;
      return current?.setable !== true || current.value === undefined;
    });
  }

  private needsNativeWattReadBeforeStart(raw: HomeyDeviceLike): boolean {
    const targetPower = raw.capabilitiesObj.target_power;
    if (!raw.capabilities.includes('target_power') || targetPower?.setable === false) return false;
    return targetPower?.setable !== true || targetPower.value === undefined
      || (raw.capabilities.includes('target_power_mode')
        && raw.capabilitiesObj.target_power_mode?.value === undefined);
  }

  private assertBinaryWriteAllowed(snapshot: TransportDeviceSnapshot | undefined, requested: CapabilityWrite): void {
    if (requested.capabilityId !== 'onoff' && requested.capabilityId !== 'evcharger_charging') return;
    if (!snapshot || snapshot.binaryCapabilityId !== requested.capabilityId) {
      throw new Error('Binary control is unavailable for this device.');
    }
    if (requested.value !== true) return;
    if (!resolveCommandableNow(snapshot) || snapshot.binaryControlObservation === undefined) {
      throw new Error('Device is not ready to start.');
    }
    if (this.needsNativeControlReadBeforeStart(snapshot)) {
      throw new Error('Native power control metadata is unavailable for starting this device.');
    }
  }

  async setCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
    if (!hasRestClient()) throw new Error('REST client not ready');
    this.assertControlAllowed(deviceId);
    const normalizedValue = normalizeCapabilityValue(this.snapshotStore, deviceId, capabilityId, value);
    const snapshotBefore = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    const requested: CapabilityWrite = { capabilityId, value: normalizedValue };
    this.assertBinaryWriteAllowed(snapshotBefore, requested);
    if (snapshotBefore?.binaryCapabilityId === capabilityId && normalizedValue === true) {
      this.currentLimitPolicy.assertStartAllowed(snapshotBefore);
    }
    // `readBackAsWritten`: whether PELS reads the requested capability back as
    // Homey holds it. Only then may the local write stand in for a read that
    // Homey dated before it.
    const sdkWrite: SwitchWrite = snapshotBefore?.binaryCapabilityId === capabilityId
        ? resolveSwitchSdkWrite(
          this.currentLimitPolicy.projectSwitchSnapshot(snapshotBefore),
          this.snapshotStore.getTrackedRawDevice(deviceId),
          requested,
          this.chargingCurrentControl.sessions,
        )
        : {
            kind: 'write',
            write: resolveCapabilitySdkWrite(this.snapshotStore.getTrackedRawDevice(deviceId), requested),
            readBackAsWritten: true,
        };
    logEvCapabilityRequest(deviceId, capabilityId, normalizedValue, snapshotBefore);
    if (sdkWrite.kind === 'none') {
        emitTransportDebug({ event: 'device_capability_write_skipped', deviceId, capabilityId,
            value: normalizedValue, reasonCode: 'no_device_command' });
        return normalizedValue;
    }
    const { write, readBackAsWritten } = sdkWrite;

    if (capabilityId === 'target_temperature' && typeof normalizedValue === 'number') {
        this.observationProducers.temperature.recordCommand(deviceId, normalizedValue, Date.now());
    }
    incPerfCounter('device_action_total');
    incPerfCounter(`device_action.capability.${capabilityId}`);
    // The Homey device behind the view: the write and its echo are the Homey device's.
    const homeyDeviceId = this.snapshotStore.sourceDeviceId(deviceId);
    const ownWrite = this.observationState.ownWrites.begin(homeyDeviceId, write.capabilityId, Date.now());
    emitCapabilityWriteDebug(
        'device_capability_write_requested',
        deviceId,
        capabilityId,
        normalizedValue,
        write,
    );
    await setRawCapabilityValue(homeyDeviceId, write.capabilityId, write.value, ownWrite.transactionId);
    emitCapabilityWriteDebug(
        'device_capability_write_accepted',
        deviceId,
        capabilityId,
        normalizedValue,
        write,
    );

    if (readBackAsWritten && (!snapshotBefore || getSnapshotAdapter(snapshotBefore).readBackAfterWrite)) {
        recordLocalWriteObservation({
            state: this.observationState.getObservationState(),
            latestSnapshot: this.snapshotStore.getSnapshot(),
            deviceId,
            capabilityId,
            value: normalizedValue,
        });
    }
    // The accepted write publishes no observed value of its own. Publish the
    // unchanged observed state so the observer projection remains an exact
    // shadow while confirmation still has to arrive through snapshot/realtime
    // telemetry. A local write recorded above (`readBackAsWritten`) does count
    // on a later read: a pulled value Homey dated before it gives way to PELS's
    // value (`observationMerge`, `retained_fresher`) until a newer observation
    // arrives.
    if (snapshotBefore?.binaryCapabilityId === capabilityId) {
        this.dispatchObservedStateForDevice(deviceId, capabilityId);
    }

    const snapshotAfter = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    logEvCapabilityAccepted(deviceId, capabilityId, normalizedValue, snapshotAfter);
    return normalizedValue;
  }

  /**
   * A home battery's signed setpoint: the claim capability is written to its
   * Homey value first, unless the battery already reports that value, then
   * `target_power` takes the setpoint mapped onto the battery's declared range,
   * in the app's own value (`toBatterySetpointCapabilityValue`: its sign, and
   * its 0 W value). Returns the watts written in PELS's sign, the setpoint
   * the executor records. A battery that reports Homey's value while it
   * no longer holds it is caught by the storage lane's claim check, as any
   * other claim lost after a setpoint is.
   *
   * The setpoint is never written after a claim write that failed. A claim
   * write Homey answered with an HTTP error status resolves as
   * `claim_rejected`, for the battery owner to judge against the binding. A
   * claim write with no answer (a timeout, a connection reset, an unreadable
   * 2xx: its outcome unknown), a refused setpoint and a missing REST client
   * throw.
   *
   * A battery driven through its app's actions has no claim to write: its
   * integration's command actions run (`HomeBatteryAppActions.command`), and
   * any failure throws.
   */
  async requestStoragePower(command: StoragePowerCommand): Promise<StoragePowerWrite> {
    const { deviceId } = command;
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    const surface = requireDrivableSurface(snapshot, deviceId);
    if (surface.kind === 'app_actions') {
      if (command.control.kind !== 'app_actions') throw new Error('Home battery command lacks app-action authority.');
      return {
        kind: 'written',
        setpointW: await this.batteryAppActions.command(deviceId, command.setpointW, command.control.target),
      };
    }
    if (command.control.kind !== 'capability') {
      throw new Error('Home battery command authority does not match binding.');
    }
    // Checked here as well as in `setCapability`, so a write that never left
    // PELS is not mistaken for one the battery's app rejected.
    if (!hasRestClient()) throw new Error('REST client not ready');
    const { response } = surface;
    if (response.kind === 'follows_meter') {
      // The mode is the command: one claim write, whatever the battery reports now.
      const setpointW = toTargetPowerCapabilityValue(command.setpointW, surface.range);
      const mode = meterModeFor(response.modes, setpointW);
      const rejected = await this.writeClaim(deviceId, surface.claim.capabilityId, mode);
      return rejected ?? { kind: 'written', setpointW };
    }
    const binding = requireHomeBatteryBinding(this.snapshotStore, deviceId);
    if (snapshot?.batteryClaim?.value !== response.claimValue) {
      const rejected = await this.writeClaim(deviceId, surface.claim.capabilityId, response.claimValue);
      if (rejected !== undefined) return rejected;
    }
    const setpointW = toTargetPowerCapabilityValue(command.setpointW, surface.range);
    await this.setCapability(
      deviceId, HOME_BATTERY_SETPOINT_CAPABILITY_ID, toBatterySetpointCapabilityValue(binding, setpointW),
    );
    return { kind: 'written', setpointW };
  }

  /**
   * Write a battery's claim capability: `undefined` once written, or the
   * rejection the battery's app answered. Only an answer is a rejection: an
   * HTTP error status, which is how Homey returns a capability listener's
   * throw (an app's own error comes back as HTTP 500, as myUplink's "Failed to
   * change the settings." does). A timeout, a connection reset or an
   * unreadable 2xx may have landed: its outcome is unknown, and it throws like
   * any other failed write.
   */
  private async writeClaim(
    deviceId: string, capabilityId: string, value: string,
  ): Promise<Extract<StoragePowerWrite, { kind: 'claim_rejected' }> | undefined> {
    try {
      await this.setCapability(deviceId, capabilityId, value);
      return undefined;
    } catch (error) {
      if (resolveHomeyHttpStatusCode(error) === undefined) throw error;
      return { kind: 'claim_rejected', errorMessage: normalizeError(error).message };
    }
  }

  /** Native solar production caps and their hand-back, without synthetic telemetry. */
  async requestProductionControl(command: import('../../ports/inverterControl').InverterCommand): Promise<void> {
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(command.deviceId);
    if (!snapshot) throw new Error('Inverter no longer exists.');
    const { deviceId } = command;
    if (command.kind === 'production_limit') {
      const surface = snapshot.inverterControl;
      if (!surface || surface.authority !== 'limit_and_release' || snapshot.available === false) {
        throw new Error('Inverter is unavailable for production limits.');
      }
      if (surface.mode === 'switchable' && snapshot.inverterObservation?.mode.kind !== 'controlled') {
        await this.setCapability(deviceId, 'target_power_mode', 'homey');
      }
      await this.setCapability(deviceId, 'target_power', command.limitW);
    } else {
      await this.releaseProduction(deviceId, snapshot.inverterControl, command.target);
    }
  }

  private async releaseProduction(
    deviceId: string,
    current: InverterControlSurface | undefined,
    target: import('../../ports/inverterControl').InverterReleaseTarget,
  ): Promise<void> {
    if (target.kind === 'watts_and_mode') this.requireInverterBinding(deviceId, target.binding);
    if (target.kind === 'watts_and_mode' && target.mode.kind === 'autonomous') {
      // In its own mode the saved target_power may be a dormant zero. Written
      // first, while PELS's mode still applies, it would cap production at
      // that value, and stay so if the mode write then failed. The mode alone
      // returns the inverter to its own control and confirms the hand-back.
      await this.setCapability(deviceId, 'target_power_mode', target.mode.value);
      return;
    }
    if (current?.authority === 'limit_and_release'
      && inverterRestorationLimitW(target.limitW, current) !== target.limitW) {
      throw new Error('The inverter production range changed before hand-back.');
    }
    await this.setCapability(deviceId, 'target_power', target.limitW);
    if (target.kind === 'watts_and_mode') {
      this.requireInverterBinding(deviceId, target.binding);
      await this.setCapability(deviceId, 'target_power_mode', target.mode.value);
    }
  }

  private requireInverterBinding(deviceId: string, expected: InverterControlBinding): void {
    const raw = this.snapshotStore.getTrackedRawDevice(deviceId);
    const current = raw?.capabilitiesObj ? resolveInverterControl(raw, raw.capabilitiesObj) : null;
    if (!current || !inverterBindingsMatch(expected, current)) {
      throw new Error('The inverter control binding changed before hand-back.');
    }
  }

  /**
   * Hand a battery back: `target_power` 0 first, so the battery is idle before
   * anyone else holds it (an exact 0 in every app's sign, never the binding's
   * 0 W hold value: an app that reads 0 as its own idle mode is handed back
   * in it), then the claim capability is restored to the value
   * recorded before PELS claimed it. The restore is written even when the 0 W
   * write failed: a battery back under its own mode no longer follows the
   * setpoint, while one left under Homey's claim would hold its last setpoint
   * through every retry back-off. Either failure then throws, the restore's
   * first. Whether the battery is still PELS's to hand back, and whether its
   * claim capability declares that value, is the battery owner's call, made
   * against its claim record; this writes unconditionally.
   *
   * A battery driven through its app's actions is handed back by its
   * integration's hand-back actions (`HomeBatteryAppActions.handBack`). A
   * command for the other kind of binding than the battery has now is refused:
   * the owner's record and the battery no longer describe the same control.
   */
  async releaseStorageControl(command: StorageReleaseCommand): Promise<void> {
    const { deviceId } = command;
    const surface = requireDrivableSurface(this.snapshotStore.getSnapshotByDeviceId(deviceId), deviceId);
    if (command.handBack === 'app_actions' && surface.kind === 'app_actions') {
      await this.batteryAppActions.handBack(deviceId, command.target);
      return;
    }
    if (command.handBack === 'legacy_app_actions' && surface.kind === 'app_actions') {
      await this.batteryAppActions.handBackLegacy(deviceId);
      return;
    }
    if (command.handBack !== 'claim_capability' || surface.kind !== 'setpoint') {
      throw new Error(`Home battery ${deviceId} hand-back does not match its control binding`);
    }
    const { restoreClaimValue } = command;
    // A meter-following battery has no setpoint to zero: restoring its mode is the whole hand-back.
    if (surface.response.kind === 'follows_meter') {
      await this.setCapability(deviceId, surface.claim.capabilityId, restoreClaimValue);
      return;
    }
    const zeroed = await this.setCapability(deviceId, HOME_BATTERY_SETPOINT_CAPABILITY_ID, 0).then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error }),
    );
    await this.setCapability(deviceId, surface.claim.capabilityId, restoreClaimValue);
    if (zeroed.failed) throw zeroed.error;
  }

  async requestSteppedLoadStep(
    params: SteppedLoadWrite,
  ): Promise<SteppedLoadStepRequestResult> {
    this.currentLimitPolicy.assertStepAllowed(params);
    const {
      deviceId,
      profile,
      desiredStepId,
      planningCurrentA,
    } = params;
    if (isSteppedLoadOffStep(profile, desiredStepId)) {
      this.observationProducers.evCarLink.noteStopCommand(deviceId, Date.now());
    }
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    const rawDevice = this.assertControlAllowed(deviceId);
    if (rawDevice && resolveChargingCurrentAdapter(rawDevice)) {
      if (isSteppedLoadOffStep(profile, desiredStepId)) {
        if (!snapshot?.binaryCapabilityId) return { requested: false };
        await this.setCapability(deviceId, snapshot.binaryCapabilityId, false);
        return { requested: true, acknowledged: true, transport: 'native_capability' };
      }
      if (this.chargingCurrentControl.routesBuiltIn(deviceId)) {
        const transport = await this.chargingCurrentControl.writeCurrent(rawDevice, planningCurrentA,
          (capabilityId, value) => this.setCapability(deviceId, capabilityId, value));
        return { requested: true, acknowledged: true, transport };
      }
    }
    if (snapshot && isNativeSteppedLoadControlEnabled(snapshot)) {
      return this.requestNativeSteppedLoadStep(params);
    }

    return this.triggerSteppedFlow(params, snapshot);
  }

  private async requestNativeSteppedLoadStep(request: SteppedLoadWrite): Promise<SteppedLoadStepRequestResult> {
    const { deviceId, profile, desiredStepId } = request;
    const nativeRequested = await this.snapshotStore.nativeSteppedAdapters.setStep(
      deviceId, profile, desiredStepId,
      (capabilityId, value) => this.setNativeStepCapability(deviceId, capabilityId, value),
    );
    if (nativeRequested === 'binary_off_required') return { requested: false, preparation: 'binary_off' };
    if (nativeRequested === 'preparation_issued') return { requested: false, preparation: 'issued' };
    return nativeRequested
      ? { requested: true, acknowledged: true, transport: 'native_capability' }
      : { requested: false };
  }

  private setNativeStepCapability(deviceId: string, capabilityId: string, value: unknown): Promise<unknown> {
    // A device without a binary pause can stop through its watt target.
    if (capabilityId === 'target_power' && value === 0) {
      this.observationProducers.evCarLink.noteStopCommand(deviceId, Date.now());
    }
    return this.setCapability(deviceId, capabilityId, value);
  }

  private async triggerSteppedFlow(
    params: SteppedLoadWrite,
    snapshot: TransportDeviceSnapshot | undefined,
  ): Promise<SteppedLoadStepRequestResult> {
    const { deviceId, desiredStepId, planningPowerW, planningCurrentA, previousStepId } = params;
    const triggerCard = this.getFlowTriggerCard('desired_stepped_load_changed');
    if (!triggerCard?.trigger) return { requested: false };

    try {
      const outcome = await awaitFlowTriggerAcceptance(() => triggerCard.trigger({
        step_id: desiredStepId,
        planning_power_w: planningPowerW,
        planning_current_a: planningCurrentA,
        previous_step_id: previousStepId ?? '',
      }, {
        deviceId,
      }));
      if (outcome === 'timed_out') {
        this.logger.structuredLog.warn({
          event: 'stepped_load_flow_trigger_unacknowledged',
          reasonCode: 'flow_trigger_timeout',
          deviceId,
          deviceName: snapshot?.name,
          desiredStepId,
          planningPowerW,
          commandTransport: 'flow',
          timeoutMs: FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS,
        });
        return { requested: true, acknowledged: false, transport: 'flow', reasonCode: 'flow_trigger_timeout' };
      }
      return { requested: true, acknowledged: true, transport: 'flow' };
    } catch (error: unknown) {
      this.logger.structuredLog.error({
        event: 'stepped_load_command_failed',
        reasonCode: 'flow_trigger_failed',
        deviceId,
        deviceName: snapshot?.name,
        desiredStepId,
        planningPowerW,
        commandTransport: 'flow',
        err: normalizeError(error),
      });
      return { requested: false };
    }
  }
}

async function awaitFlowTriggerAcceptance(
    trigger: () => Promise<unknown> | unknown,
): Promise<'accepted' | 'timed_out'> {
    let acceptanceTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const triggerResult = Promise.resolve()
            .then(trigger)
            .then(() => 'accepted' as const);
        const timeoutResult = new Promise<'timed_out'>((resolve) => {
            acceptanceTimeout = setTimeout(() => resolve('timed_out'), FLOW_TRIGGER_ACCEPTANCE_TIMEOUT_MS);
            acceptanceTimeout.unref();
        });
        return await Promise.race([triggerResult, timeoutResult]);
    } finally {
        if (acceptanceTimeout) clearTimeout(acceptanceTimeout);
    }
}
