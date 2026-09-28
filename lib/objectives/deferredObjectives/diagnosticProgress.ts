/**
 * Progress resolvers for the deferred-objective diagnostic bridge. Splits
 * out so the bridge file stays under the 500 LOC eslint cap.
 *
 * Returns whether the device's current SoC / temperature is usable to feed
 * the bucket allocator, plus the reason code the bridge surfaces when
 * progress is unavailable.
 *
 * Temperature thermostats only push capability updates on value change, so a
 * perfectly working device steady at setpoint falls silent for hours. Smart-task
 * planning therefore credits the last-seen temperature for any device that has
 * ever produced one, and only suppresses planning when the device has never
 * reported a value at all. That question is answered by the temperature itself:
 * the producer emits `currentTemperature` only when the device carries the
 * observed temperature facet (`resolveTemperatureInputFields` in
 * `lib/planInput/projectPlanInputDevice.ts` — no facet plans as `'onoff'`), so a finite
 * reading IS the proof, and no timestamp is consulted. It does not suppress on
 * the reading's AGE, and nothing else in the app does either — PELS has no
 * timeout that turns a quiet device into an untrusted one.
 *
 * EV SoC stays strictly fresh because charger session validity genuinely
 * requires per-session telemetry.
 *
 * An energy task reads no level of the device at all: its progress is the energy
 * the device has taken since the task started, counted by
 * `EnergyTaskDeliveryTracker` (`energyDelivery.ts`) and handed in as a reader.
 * That count is always known — a task that has fed nothing yet has fed 0 kWh —
 * so the only way it fails is the session question EV tasks also ask.
 *
 * Stuck-sensor residual risk: a thermostat alive on the radio but reporting
 * a fixed wrong value will be planned against that wrong value. The whole
 * Homey state model assumes capability readings are trustworthy, so every
 * consumer (this app, native thermostat schedules, other Homey apps) is
 * vulnerable to the same failure mode. Containment is upstream — capacity
 * guard and daily budget bound the energy blast radius, and the divergence
 * between the sensor and reality is visible to the user. PELS specifically
 * does not try to detect this.
 */
import {
  resolveObjectiveProgressDirection,
  type ObjectiveDeviceInput,
  type ObjectiveProgressDirection,
} from '../../objectives/types';
import type {
  DeferredObjectiveEnergySettingsEntry,
  DeferredObjectiveSettingsEntry,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { DeliveredEnergyReader } from './energyDelivery';

// `currentValue` is the reading in the task's own unit (% for an EV task, °C
// for a temperature task, kWh delivered for an energy task); the diagnostic
// places it in its kind's column. A resolved read always has one; an
// unresolved read has one only when the axis still knows it (an energy task
// paused on its session still knows what it has delivered).
export type DeferredObjectiveProgressResolution = {
  remainingUnits: number;
  progressDirection: ObjectiveProgressDirection;
  currentValue: number;
  reasonCode: null;
} | {
  remainingUnits: 0;
  progressDirection: ObjectiveProgressDirection;
  currentValue: number | null;
  reasonCode:
  | 'objective_invalid_session'
  | 'objective_missing_temperature'
  | 'objective_progress_stale';
};

type EvProgress = {
  currentPercent: number;
  reasonCode: null;
} | {
  currentPercent: number | null;
  reasonCode: 'objective_invalid_session' | 'objective_progress_stale';
};

const resolveEvObjectiveProgress = (device: ObjectiveDeviceInput): EvProgress => {
  // "There is no creditable session" is the whole precondition, and the producer
  // has already answered it. Reading the resolved boolean rather than the
  // plug-state keeps the question out of this layer — and the plug-state is not
  // here to read anyway: `toPlanDevice` strips `evChargingState`, so the
  // `isEvSessionInactive(device.evChargingState)` this replaced was a dead
  // branch that never once fired in production. An unplugged charger reported
  // `objective_progress_stale` — a reading problem — for entire task windows.
  //
  // NOT `commandableNow`: that also goes false for `available === false` and for
  // PELS's own binary-command retry back-off, and this code renders as "EV is
  // unplugged — plug in to resume."
  if (device.objectiveSessionInactive) {
    return { currentPercent: null, reasonCode: 'objective_invalid_session' };
  }
  const level = device.stateOfCharge?.level;
  if (level === undefined) {
    return { currentPercent: null, reasonCode: 'objective_progress_stale' };
  }
  if (level.kind !== 'known') {
    // The percent is NOT carried through. Reporting a level the producer does
    // not stand behind, alongside the reason it does not, is what let a cached
    // "On track" survive on a device whose reading had gone.
    return {
      currentPercent: null,
      reasonCode: level.reasonCode === 'not_connected'
        ? 'objective_invalid_session'
        : 'objective_progress_stale',
    };
  }
  return { currentPercent: level.percent, reasonCode: null };
};

const hasUsableTemperatureProgress = (params: {
  device: ObjectiveDeviceInput;
}): params is {
  device: ObjectiveDeviceInput & { currentTemperature: number };
} => {
  // A finite `currentTemperature` is proof the device has produced at least one
  // observation — the producer emits the field only for a device carrying the
  // temperature facet. That is the only gate this resolver needs: aged-out
  // readings are still useful because thermostats fall silent at setpoint, and
  // a device that never reported has no field to read.
  const { device } = params;
  return typeof device.currentTemperature === 'number' && Number.isFinite(device.currentTemperature);
};

/**
 * The target this task can actually reach, in the task's own unit: the owner's
 * target, capped by the car's own charge limit when an EV task's car stops below
 * it (owner ruling 2026-09-26). The limit is the one the device layer resolved
 * from the car's own repeated stops and lends with the car's level
 * (`carChargeLimitPercent`); nothing here infers one. A car that stops at 70 %
 * cannot be charged to 80 % by any plan, so energy is sized to 70 % and the
 * task is met there. Every other task reaches its target.
 */
export const resolveReachableTargetValue = (
  objective: DeferredObjectiveSettingsEntry,
  device: ObjectiveDeviceInput | undefined,
): number => {
  if (objective.kind === 'temperature') return objective.targetTemperatureC;
  if (objective.kind === 'energy') return objective.targetEnergyKWh;
  const level = device?.stateOfCharge?.level;
  const carChargeLimitPercent = level?.kind === 'known' ? level.carChargeLimitPercent : undefined;
  return carChargeLimitPercent === undefined
    ? objective.targetPercent
    : Math.min(objective.targetPercent, carChargeLimitPercent);
};

/**
 * Energy delivered since the task started, against the energy asked for. An
 * amount of energy only ever grows. The session check is the one every kind
 * asks; a pure on/off device (the only kind that carries an energy task) never
 * lacks a session.
 */
const resolveEnergyObjectiveProgress = (
  objective: DeferredObjectiveEnergySettingsEntry,
  device: ObjectiveDeviceInput,
  readDeliveredEnergy: DeliveredEnergyReader,
): DeferredObjectiveProgressResolution => {
  const deliveredKWh = readDeliveredEnergy(device.id, objective.deadlineAtMs);
  if (device.objectiveSessionInactive) {
    return {
      remainingUnits: 0,
      progressDirection: 'increasing',
      currentValue: deliveredKWh,
      reasonCode: 'objective_invalid_session',
    };
  }
  return {
    remainingUnits: Math.max(0, objective.targetEnergyKWh - deliveredKWh),
    progressDirection: 'increasing',
    currentValue: deliveredKWh,
    reasonCode: null,
  };
};

// No `nowMs`: no axis asks how old a reading is. EV SoC rejects on session
// validity, temperature on the absence of the facet, energy on session validity
// alone — all value questions.
export const resolveObjectiveProgress = (
  objective: DeferredObjectiveSettingsEntry,
  device: ObjectiveDeviceInput,
  readDeliveredEnergy: DeliveredEnergyReader,
): DeferredObjectiveProgressResolution => {
  if (objective.kind === 'energy') return resolveEnergyObjectiveProgress(objective, device, readDeliveredEnergy);
  const progressDirection = resolveObjectiveProgressDirection({
    objectiveKind: objective.kind,
    thermalDirection: device.thermalDirection,
  });
  if (objective.kind === 'ev_soc') {
    const progress = resolveEvObjectiveProgress(device);
    if (progress.reasonCode) {
      return {
        remainingUnits: 0,
        progressDirection,
        currentValue: progress.currentPercent,
        reasonCode: progress.reasonCode,
      };
    }
    const remainingUnits = Math.max(0, resolveReachableTargetValue(objective, device) - progress.currentPercent);
    // A bare-connected charger (`plugged_in`) no longer blocks the objective. The
    // block rested on "PELS cannot drive the charger toward the target", and that
    // is false: `plugged_in` is commandable, and on prod 2026-07-26 PELS started a
    // session on a charger sitting in exactly this state (Easee reports op mode 7
    // "Awaiting Authentication" as `plugged_in`, and the `evcharger_charging` write
    // IS the authorization).
    //
    // Blocking here did real damage, because it did not merely annotate — it
    // returned `remainingUnits: 0` with a reason code, so `diagnosticsBridge` could
    // not reach the satisfied path AND `profileEnergyResolution` computed zero
    // energy needed. The task therefore planned no hours and never admitted the
    // charger, which is precisely the deadline PELS was supposed to be driving.
    //
    // The charger not actually starting is still possible (a go-e reports a
    // finished session as `plugged_in` too). That is caught downstream where the
    // evidence lives — `activationBackoff` penalises a device commanded on that
    // never draws, and the at-risk lane sees the missing delivery — rather than by
    // pre-emptively refusing to plan.
    return {
      remainingUnits,
      progressDirection,
      currentValue: progress.currentPercent,
      reasonCode: null,
    };
  }

  if (!hasUsableTemperatureProgress({ device })) {
    // Only one way to fail now: the device carries no temperature facet, so it
    // has never reported one. A finite reading is never rejected — there is no
    // age test here, so `objective_progress_stale` is not reachable on this
    // axis (it remains the EV-SoC answer, where session validity does need
    // per-session telemetry).
    return {
      remainingUnits: 0,
      progressDirection,
      currentValue: null,
      reasonCode: 'objective_missing_temperature',
    };
  }
  const usableTemperatureC = Number(device.currentTemperature);
  const remainingTemperature = device.thermalDirection === 'cooling'
    ? usableTemperatureC - objective.targetTemperatureC
    : objective.targetTemperatureC - usableTemperatureC;
  return {
    remainingUnits: Math.max(0, remainingTemperature),
    progressDirection,
    currentValue: usableTemperatureC,
    reasonCode: null,
  };
};
