import type { DeviceStatus } from '../../packages/contracts/src/deviceStatus';
import type { ChargingInstallationCard, DeviceStatusInput } from './deviceStatusInput';
import { displayStateLabel, displayStateTone } from '../../packages/shared-domain/src/planCardGrammar';
import { EV_BLOCK_REASON_CODES } from '../../packages/shared-domain/src/commandableNowReason';
import {
  isEvPlugStateBlocked, isEvPlugStateConnected, resolveEvChargeAction,
} from '../../packages/shared-domain/src/evPlugState';

const DRAWING_KW = 0.05;
const formatKw = (kw: number): string => `${kw.toFixed(1)} kW`;

/** The main's reason line, when no reason of its own needs the line. */
function resolveChargingInstallationReason(
  installation: ChargingInstallationCard | undefined,
): DeviceStatus['reason'] {
  if (installation?.role !== 'main') return null;
  return { text: 'Sets the available current for this installation.' };
}

/**
 * The main's power line: its own draw, then the installation's total, so the
 * total keeps its place whatever the reason line says.
 */
function withInstallationTotal(
  device: DeviceStatusInput,
  power: Pick<DeviceStatus, 'powerText' | 'powerVariant'>,
): Pick<DeviceStatus, 'powerText' | 'powerVariant'> {
  const installation = device.chargingInstallation;
  if (installation?.role !== 'main' || installation.totalKw === undefined) return power;
  const total = `installation ${formatKw(installation.totalKw)}`;
  const measured = device.currentDrawKw === undefined ? null : formatKw(device.currentDrawKw);
  const own = power.powerVariant === 'before_switch_off' ? power.powerText : measured;
  const powerVariant = power.powerVariant === 'expected' ? 'live' : power.powerVariant;
  return { powerVariant, powerText: own ? `${own} · ${total}` : total };
}

/**
 * A secondary's card describes its own charging. A car asking for power
 * while its switch is on can be waiting for the installation's current.
 */
function buildSecondaryChargerStatus(
  device: DeviceStatusInput,
  cardKind: DeviceStatus['cardKind'],
  reading: DeviceStatus['reading'],
): DeviceStatus | null {
  const installation = device.chargingInstallation;
  if (installation?.role !== 'secondary' || !device.execution.available) return null;
  const draw = device.currentDrawKw;
  const drawing = draw !== undefined && draw > DRAWING_KW;
  const switchedOn = device.execution.physicalState === 'on';
  const waitingForCurrent = switchedOn && isRequestingPower(device.evChargingState);
  let kind: 'active' | 'idle' | 'off' = 'off';
  const unplugged = device.evChargingState !== undefined && !isEvPlugStateConnected(device.evChargingState);
  let factText = unplugged ? 'Unplugged' : 'Not charging';
  if (drawing) {
    kind = 'active';
    factText = 'Charging';
  } else if (waitingForCurrent) {
    kind = 'idle';
    factText = 'Waiting for current';
  }
  return {
    cardKind, kind, tone: displayStateTone(kind), label: displayStateLabel(kind),
    powerText: draw === undefined ? null : formatKw(draw), powerVariant: 'live',
    factText, reading,
    reason: installation.mainName === undefined ? null : {
      text: `Its current is set through ${installation.mainName}. `
        + 'The chargers share the available current between the cars that are charging.',
    },
    rail: null, limited: false, wouldLimit: false, canEaseOff: false, controlOffDrawing: false, holdCause: null,
  };
}

/** A car still asking for power: not one that finished, stopped itself, discharges or is unplugged. */
function isRequestingPower(state: DeviceStatusInput['evChargingState']): boolean {
  if (state === undefined) return false;
  return isEvPlugStateBlocked(state)
    ? EV_BLOCK_REASON_CODES[state] === 'charger_waiting'
    : resolveEvChargeAction(state) !== 'offer';
}

/**
 * A card as a charging installation shapes it, from the card the device would
 * have on its own: a secondary's card is replaced by its own observation, and
 * the main's gains the installation's total on its power line and, when no
 * reason of its own needs the line, says it sets the installation's current.
 */
export function withChargingInstallation(device: DeviceStatusInput, status: DeviceStatus): DeviceStatus {
  const installation = device.chargingInstallation;
  if (installation === undefined) return status;
  const secondary = buildSecondaryChargerStatus(device, status.cardKind, status.reading);
  if (secondary) return secondary;
  return {
    ...status,
    ...withInstallationTotal(device, status),
    reason: status.reason ?? resolveChargingInstallationReason(installation),
  };
}
