import type { PlanInputDevice } from './planInputDevice.js';

/**
 * What the owner's temperature intent means for ONE temperature device this
 * build: the setpoints the planner chooses between, and the facts it reads
 * about them. Resolved before the planner by `lib/thermostat`, which is the only
 * place a setpoint is computed or two setpoints are ordered.
 *
 * The planner decides OUTCOMES — keep the device, lift it for surplus, limit it
 * — and reads the setpoint that outcome commands from here. It never applies a
 * delta, never folds a floor, and never compares two setpoints with `<` or `>`:
 * which way is "more demand" depends on whether the device is heating or
 * cooling, and the planner is not told. Every question that needs that order is
 * answered here as a fact.
 *
 * Capability-normalized where the planner commands the value (`keepC`,
 * `surplusC`); raw where it is the owner's number reported back (`intendedC`,
 * `desiredC`).
 */
/**
 * The device's shed behaviour this build, resolved: how PELS limits it when it
 * does. Every variant is an action; a setpoint limit carries the capability-
 * normalized setpoint PELS writes and the facts about it that depend on which
 * way the device moves demand.
 */
export type ResolvedShedBehavior =
  | { action: 'turn_off' }
  | { action: 'set_step' }
  | {
    action: 'set_temperature';
    /** The configured limit for the device's direction, capability-normalized: what PELS writes. */
    limitC: number;
    /**
     * Moving the device to `limitC` would release demand from the target it holds
     * now. `false` for a device already at its limit, and for one whose limit
     * sits on the demand side of its target, where writing it would make the
     * device work harder.
     */
    releasesDemand: boolean;
    /** `limitC` asks for less work than `intendedC` by more than half a target step. */
    asksLessThanIntended: boolean;
  };

export type TemperatureSetpoints = {
  /** The active mode's target for the device, or its own setpoint when the mode has none. */
  intendedC: number;
  /** `intendedC` with this hour's price shift applied: what the owner wants the device at now. */
  desiredC: number;
  /**
   * What PELS commands when it neither limits the device nor lifts it for
   * surplus: `desiredC` held at the smart-task deadline floor when one applies.
   */
  keepC: number;
  /** `keepC` with the owner's surplus lift applied. Equal to `keepC` for a device with no lift. */
  surplusC: number;
  /** The capability's step, or a default by temperature range. Half of it is the tolerance of the `…AsksLessThanIntended` facts. */
  targetStepC: number;
  shed: ResolvedShedBehavior;
  /** Commanding `keepC` from the target the device holds now asks it to work harder: a resume, not a limit. */
  keepAddsDemand: boolean;
  /** Commanding `surplusC` from the target the device holds now asks it to work harder. */
  surplusAddsDemand: boolean;
  /** `keepC` asks for less work than `intendedC` by more than half a target step — an expensive-hour shift, typically. */
  keepAsksLessThanIntended: boolean;
  /** `surplusC` asks for less work than `intendedC` by more than half a target step. */
  surplusAsksLessThanIntended: boolean;
  /** The device's observed target is short of `desiredC`, as the capability can hold it, by at least 0.5 °C on the device's own axis. */
  targetShortOfDesired: boolean;
  /** The room is short of `intendedC` by more than half a target step — colder for a heater, warmer for a cooling unit. */
  roomShortOfIntended: boolean;
};

/**
 * One entry per temperature device in the build's input set, and none for any
 * other device. The planner reads an entry only after narrowing a device to a
 * temperature device, so the entry is guaranteed there.
 */
export type TemperatureSetpointsByDevice = ReadonlyMap<string, TemperatureSetpoints>;

/**
 * The seam the plan builder calls once per build, after the smart-task
 * decoration has stamped any deadline floor onto the admitted devices.
 */
export type ResolveTemperatureSetpoints = (devices: readonly PlanInputDevice[]) => TemperatureSetpointsByDevice;
