import type { ChargingPhaseCount } from '../../packages/contracts/src/chargingPhases';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { ChargingPhaseEnvelope, ChargingPhasePoint } from '../../packages/planner-types/src/chargingPhases';
import type { ChargingPhaseCommand, ChargingPhaseDevice } from '../ports/chargingPhases';
import { CHARGING_PHASE_POWER_NOISE_W } from '../ports/chargingPhases';
import { chargingSingleHousePhase, resolveChargingPhaseFootprint, resolveChargingPhaseObservedPoint }
  from '../phaseFootprint/chargingPhaseFootprints';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceControlSettings } from './deviceControlSettings';
import type { ChargingPhaseBinding } from './deviceAdapter';
import type { CapabilityWrite } from './deviceAdapter';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import {
  FLOW_ACTION_CARDS_API_PATH, readFlowActionCardIds, resolveDeviceActionCard, type DeviceActionStep,
} from './flowActionCards';
import type { HomeyActionAccess } from './transport/homeyActionAccess';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';
import type { TransportSnapshotStore } from './transport/transportSnapshotStore';
import type { EvChargingCurrentPolicy } from './evChargingCurrentLimitSettings';
import { isEvChargingState, isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import { toCapabilityTimestampMs } from './managerControl';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import { resolveAutomaticSteppedLoadProfile } from './nativeSteppedLoadWiring';

/** Per-phase meter noise below this is not charging evidence. */
export const CHARGING_PHASE_DRAWING_W = CHARGING_PHASE_POWER_NOISE_W;

/** A measured operating envelope; idle never changes the last accepted envelope. */
export function measuredChargingPhases(
  device: Pick<ChargingPhaseDevice, 'powers' | 'totalPower'>,
): ChargingPhaseCount | undefined {
  const [a, b, c] = device.powers.map((reading) => reading.watts > CHARGING_PHASE_DRAWING_W);
  if (b || c) return 3;
  const sum = device.powers.reduce((watts, reading) => watts + reading.watts, 0);
  if (Math.abs(sum - device.totalPower.watts) > CHARGING_PHASE_DRAWING_W) return undefined;
  if (!a && !b && !c) return undefined;
  return a && !b && !c ? 1 : 3;
}

type PhaseSettings = Pick<DeviceControlSettings,
  'getDeviceChargingPhaseSettings' | 'getDeviceTargetPowerConfig' | 'getDevicePhaseConnection'
  | 'isManaged' | 'isControllable'>;
type PhaseReading = NonNullable<ReturnType<ChargingPhaseBinding['read']>>;
type CurrentRange = { minimumCurrentA: number; maximumCurrentA: number; allowed: boolean };

/**
 * Device-owner host for integration-resolved phase reads and action cards. It never
 * decides a desired phase count, starts a device, or treats a command echo as draw.
 */
export class ChargingPhaseTransport {
  private readonly measured = new Map<string, { phases: ChargingPhaseCount; observedAtMs: number }>();
  private readonly connections = new Map<string, { connected: boolean; observedAtMs: number }>();
  private readonly revokedEvidence = new Map<string, string>();
  /** Once claimed, phase geometry remains producer-owned through opt-out and hand-back. */
  private readonly ownedModels = new Set<string>();

  constructor(
    private readonly snapshots: TransportSnapshotStore,
    private readonly settings: PhaseSettings,
    private readonly access: HomeyActionAccess,
    private readonly pause: (deviceId: string) => Promise<void>,
    private readonly currentPolicy: (deviceId: string) => EvChargingCurrentPolicy,
    private readonly writeCapability: (deviceId: string, write: CapabilityWrite) => Promise<void>,
  ) {}

  /** Phase-capable installations retain producer-owned geometry through hand-back and restart. */
  profile(device: HomeyDeviceLike): SteppedLoadProfile | undefined {
    const installation = this.settings.getDevicePhaseConnection(device.id);
    if (this.settings.getDeviceChargingPhaseSettings(device.id) !== undefined
      || chargingSingleHousePhase(installation) !== undefined) this.ownedModels.add(device.id);
    if (!this.ownedModels.has(device.id)) return undefined;
    const binding = this.binding(device);
    if (binding === undefined) return undefined;
    const read = binding.read(device);
    const phases = this.planningPhases(device, read);
    return binding.profile(device, phases);
  }

  /** One descriptor and its configuration must use the same geometry, including a saved Manual model. */
  projectProfile(snapshot: TransportDeviceSnapshot, device: HomeyDeviceLike): TransportDeviceSnapshot {
    const ownedProfile = this.profile(device);
    if (!ownedProfile && snapshot.automaticPowerControl?.mode !== 'automatic') return snapshot;
    if (!this.binding(device)) return snapshot;
    const profile = ownedProfile
      ?? resolveAutomaticSteppedLoadProfile(device, device.capabilities, getDeviceAdapter(device).observation(device));
    if (!profile) return snapshot;
    const sameProfile = JSON.stringify(profile) === JSON.stringify(snapshot.steppedLoadProfile);
    if (sameProfile && (!ownedProfile || snapshot.targetPowerConfig === undefined)) return snapshot;
    const step = profile.steps.find((entry) => entry.id === snapshot.reportedStepId);
    return {
      ...snapshot, steppedLoadProfile: profile,
      automaticPowerControl: { mode: snapshot.automaticPowerControl?.mode ?? 'automatic', profile },
      ...(ownedProfile ? { targetPowerConfig: undefined } : {}),
      ...(step === undefined ? {} : { reportedStepPowerW: step.planningPowerW }),
    };
  }

  readDevices(): readonly ChargingPhaseDevice[] {
    for (const id of this.connections.keys()) {
      if (this.snapshots.getDeviceMembership(id) !== 'removed') continue;
      this.connections.delete(id);
      this.measured.delete(id);
      this.revokedEvidence.delete(id);
      this.ownedModels.delete(id);
    }
    return [...this.snapshots.getLastAcceptedRawDevicesById().values()].flatMap((device) => {
      const read = this.readDevice(device);
      return read ? [read] : [];
    });
  }

  private readDevice(device: HomeyDeviceLike): ChargingPhaseDevice | undefined {
    const reading = this.binding(device)?.read(device);
    if (!reading) return undefined;
    const snapshot = this.snapshots.getSnapshotByDeviceId(device.id);
    const state = snapshot?.evChargingState ?? device.capabilitiesObj.evcharger_charging_state?.value;
    const range = this.currentRange(device.id, reading);
    const controlEnabled = this.settings.isControllable(device.id) && range.allowed
      && snapshot?.automaticPowerControl?.mode === 'automatic' && snapshot.controlAdapter?.activationEnabled === true;
    return { deviceId: device.id, ...reading,
      minimumCurrentA: range.minimumCurrentA, maximumCurrentA: range.maximumCurrentA,
      available: snapshot?.available ?? device.available,
      connected: isEvChargingState(state) && isEvPlugStateConnected(state),
      managed: this.settings.isManaged(device.id), controlEnabled,
      configuredPhases: this.configuredPhases(device.id), planningPhases: this.planningPhases(device, reading),
      drawingPhases: this.drawingPhases(device, reading),
    };
  }

  private currentRange(deviceId: string, reading: PhaseReading): CurrentRange {
    const policy = this.currentPolicy(deviceId);
    const minimumCurrentA = policy.kind === 'limited'
      ? Math.max(reading.minimumCurrentA, policy.limits.minA) : reading.minimumCurrentA;
    const maximumCurrentA = policy.kind === 'limited'
      ? Math.min(reading.maximumCurrentA, policy.limits.maxA) : reading.maximumCurrentA;
    return { minimumCurrentA, maximumCurrentA,
      allowed: policy.kind !== 'hold' && minimumCurrentA <= maximumCurrentA };
  }

  private planningPhases(device: HomeyDeviceLike, reading: PhaseReading | undefined): ChargingPhaseCount {
    const connection = this.observeConnection(device);
    if (reading !== undefined && connection?.connected === true) this.observe(device.id, reading);
    if (reading?.forceSinglePhase && this.measured.get(device.id)?.phases === 1) return 1;
    return this.configuredPhases(device.id);
  }

  private drawingPhases(device: HomeyDeviceLike, reading: PhaseReading): ChargingPhaseCount | undefined {
    if (this.observeConnection(device)?.connected !== true
      || this.revokedEvidence.get(device.id) === phasePowerSignature(reading)) return undefined;
    return measuredChargingPhases(reading);
  }

  envelopes(device: ChargingPhaseDevice): readonly ChargingPhaseEnvelope[] {
    const raw = this.snapshots.getLastAcceptedRawDevice(device.deviceId);
    const binding = raw && this.binding(raw);
    if (!raw || !binding) return [];
    const connection = this.settings.getDevicePhaseConnection(device.deviceId);
    return ([1, 3] as const).flatMap((phases) => {
      const full = binding.profile(raw, phases);
      const maximumW = this.settings.getDeviceTargetPowerConfig(device.deviceId)?.max;
      const profile = full && { ...full, steps: full.steps.filter((step) => step.planningCurrentA === 0
        || (step.planningCurrentA !== undefined && step.planningCurrentA >= device.minimumCurrentA
          && step.planningCurrentA <= device.maximumCurrentA
          && (maximumW === undefined || step.planningPowerW <= maximumW))) };
      return profile === undefined ? [] : [{ phases, profile,
        footprint: resolveChargingPhaseFootprint(connection, phases) }];
    });
  }

  observedPoint(device: ChargingPhaseDevice, phases: ChargingPhaseCount): ChargingPhasePoint {
    return resolveChargingPhaseObservedPoint(device, phases, this.settings.getDevicePhaseConnection(device.deviceId));
  }

  /** Hand-back can permit three phases while idle; pre-hand-back one-phase draw cannot size the next start. */
  resetEnvelope(deviceId: string, forceSinglePhase: boolean): void {
    this.ownedModels.add(deviceId);
    if (forceSinglePhase) return;
    this.measured.delete(deviceId);
    const raw = this.snapshots.getLastAcceptedRawDevice(deviceId);
    const read = raw && this.binding(raw)?.read(raw);
    if (read) this.revokedEvidence.set(deviceId, phasePowerSignature(read));
  }

  /** All callers arrive through the actuator; the phase owner serializes these with ordinary current writes. */
  async request(command: ChargingPhaseCommand): Promise<boolean> {
    if (!command.authority.isCurrent()) return false;
    const raw = this.snapshots.getLastAcceptedRawDevice(command.deviceId);
    const binding = raw && this.binding(raw);
    if (!raw || !binding) throw new Error('Charging phase control is unavailable.');
    const reading = binding.read(raw);
    if (!reading) throw new Error('Charging phase observations are unavailable.');
    if (command.kind === 'charging_phase_release') {
      const prepared = await this.prepareRelease(command, reading);
      if (prepared === 'unchanged') return true;
      if (prepared === 'expired') return false;
    } else {
      this.assertCurrentAllowed(command, reading);
    }
    const delivery = binding.command(raw, command);
    return delivery.kind === 'capabilities'
      ? this.writeNative(command, delivery.writes) : this.writeAction(command, binding, delivery.step);
  }

  private assertCurrentAllowed(
    command: Exclude<ChargingPhaseCommand, { kind: 'charging_phase_release' }>, reading: PhaseReading,
  ): void {
    this.assertSwitchAllowed(command);
    if (!Number.isInteger(command.currentA) || command.currentA < reading.minimumCurrentA
      || command.currentA > reading.maximumCurrentA) throw new Error('Charging phase current is outside its range.');
  }

  private async prepareRelease(
    command: Extract<ChargingPhaseCommand, { kind: 'charging_phase_release' }>, reading: PhaseReading,
  ): Promise<'ready' | 'unchanged' | 'expired'> {
    if (command.forceSinglePhase === reading.forceSinglePhase) return 'unchanged';
    if (command.forceSinglePhase || reading.currentLimitA === 0) return 'ready';
    if (!command.authority.isCurrent()) return 'expired';
    command.pauseLifecycle.onStarting(Date.now());
    try {
      if (!command.authority.isCurrent()) throw new Error('Charging phase authority expired before pause.');
      await this.pause(command.deviceId);
      command.pauseLifecycle.onAccepted();
    } catch (error) {
      command.pauseLifecycle.onFailed(error);
      throw error;
    }
    return command.authority.isCurrent() ? 'ready' : 'expired';
  }

  /** Phase expansion hand-back is never sent after a third party raised the current during its pause. */
  private canDeliver(command: ChargingPhaseCommand): boolean {
    if (!command.authority.isCurrent()) return false;
    if (command.kind !== 'charging_phase_release') {
      this.assertSwitchAllowed(command);
      return true;
    }
    if (command.forceSinglePhase) return true;
    const raw = this.snapshots.getLastAcceptedRawDevice(command.deviceId);
    return raw !== undefined && this.binding(raw)?.read(raw)?.currentLimitA === 0;
  }

  private async writeNative(command: ChargingPhaseCommand, writes: readonly CapabilityWrite[]): Promise<boolean> {
    for (const write of writes) {
      if (!this.canDeliver(command)) return false;
      await this.writeCapability(command.deviceId, write);
    }
    return command.authority.isCurrent();
  }

  private async writeAction(
    command: ChargingPhaseCommand, binding: ChargingPhaseBinding, step: DeviceActionStep,
  ): Promise<boolean> {
    const cards = readFlowActionCardIds(await getRawFromHomeyApi(FLOW_ACTION_CARDS_API_PATH));
    const action = resolveDeviceActionCard(cards, binding.appUri, step);
    if (action === undefined) throw new Error('The charger phase action is unavailable.');
    if (!this.canDeliver(command)) return false;
    try {
      await this.access.runAction(command.deviceId, action, 'charging_phase', () => {
        if (!this.canDeliver(command)) throw new Error('Charging phase authority expired.');
        const current = this.snapshots.getLastAcceptedRawDevice(command.deviceId);
        if (!current || this.binding(current)?.appUri !== binding.appUri) {
          throw new Error('Charging phase binding changed.');
        }
      });
      return command.authority.isCurrent();
    } catch (error) {
      if (!this.canDeliver(command)) return false;
      throw error;
    }
  }

  private binding(device: HomeyDeviceLike): ChargingPhaseBinding | undefined {
    return getDeviceAdapter(device).phaseBindings(device)[0];
  }

  private configuredPhases(deviceId: string): ChargingPhaseCount {
    if (chargingSingleHousePhase(this.settings.getDevicePhaseConnection(deviceId)) !== undefined) return 3;
    return this.settings.getDeviceTargetPowerConfig(deviceId)?.preset === 'ev_charger_1_phase' ? 1 : 3;
  }

  private assertSwitchAllowed(
    command: Exclude<ChargingPhaseCommand, { kind: 'charging_phase_release' }>,
  ): void {
    const settings = this.settings.getDeviceChargingPhaseSettings(command.deviceId);
    if (settings === undefined || !this.settings.isManaged(command.deviceId)
      || !this.settings.isControllable(command.deviceId)
      || (command.kind === 'charging_phase' && settings.mode === 'single' && command.phases !== 1)
      || (command.kind === 'charging_phase' && settings.mode === 'three' && command.phases !== 3)) {
      throw new Error('Charging phase control is no longer enabled for this request.');
    }
    const policy = this.currentPolicy(command.deviceId);
    if (policy.kind === 'hold' || (policy.kind === 'limited'
      && (command.currentA < policy.limits.minA || command.currentA > policy.limits.maxA))) {
      throw new Error('Charging phase current is outside the active charging range.');
    }
  }

  private observeConnection(device: HomeyDeviceLike): { connected: boolean; observedAtMs: number } | undefined {
    const state = device.capabilitiesObj.evcharger_charging_state;
    if (!isEvChargingState(state?.value)) return this.connections.get(device.id);
    const observedAtMs = toCapabilityTimestampMs(state.lastUpdated);
    if (observedAtMs === undefined) return this.connections.get(device.id);
    const connected = isEvPlugStateConnected(state.value);
    const previous = this.connections.get(device.id);
    if (previous?.connected === connected) return previous;
    if (!connected) {
      this.measured.delete(device.id);
      const read = this.binding(device)?.read(device);
      if (read) this.revokedEvidence.set(device.id, phasePowerSignature(read));
    }
    const next = { connected, observedAtMs };
    this.connections.set(device.id, next);
    return next;
  }

  private observe(deviceId: string, device: Pick<ChargingPhaseDevice, 'powers' | 'totalPower'>): void {
    if (this.revokedEvidence.get(deviceId) === phasePowerSignature(device)) return;
    const phases = measuredChargingPhases(device);
    if (phases === undefined) return;
    const observedAtMs = Math.max(...device.powers.map((reading) => reading.observedAtMs));
    const previous = this.measured.get(deviceId);
    if (previous === undefined || observedAtMs >= previous.observedAtMs) {
      this.measured.set(deviceId, { phases, observedAtMs });
    }
  }
}

/** A permission change revokes that report's context, never its independent held power truth. */
function phasePowerSignature(device: Pick<ChargingPhaseDevice, 'powers' | 'totalPower'>): string {
  return JSON.stringify([...device.powers, device.totalPower]);
}
