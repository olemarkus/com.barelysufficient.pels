import type { HeadroomCardCooldownSource } from './planHeadroomDevice';

export type ShedAction = 'turn_off' | 'set_temperature';

export type ShedBehavior = {
  action: ShedAction;
  temperature?: number;
};

export type DevicePlanDevice = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  currentTarget: unknown;
  plannedTarget: number | null;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  budgetExempt?: boolean;
  currentTemperature?: number;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
  available?: boolean;
  headroomCardBlocked?: boolean;
  headroomCardCooldownSec?: number | null;
  headroomCardCooldownSource?: HeadroomCardCooldownSource;
  headroomCardCooldownFromKw?: number | null;
  headroomCardCooldownToKw?: number | null;
};

export type DevicePlan = {
  meta: {
    totalKw: number | null;
    softLimitKw: number;
    capacitySoftLimitKw?: number;
    dailySoftLimitKw?: number | null;
    softLimitSource?: 'capacity' | 'daily' | 'both';
    headroomKw: number | null;
    hourlyBudgetExhausted?: boolean;
    usedKWh?: number;
    budgetKWh?: number;
    minutesRemaining?: number;
    controlledKw?: number;
    uncontrolledKw?: number;
    hourControlledKWh?: number;
    hourUncontrolledKWh?: number;
    dailyBudgetRemainingKWh?: number;
    dailyBudgetExceeded?: boolean;
    dailyBudgetHourKWh?: number;
  };
  devices: DevicePlanDevice[];
};

export type PlanInputDevice = {
  id: string;
  name: string;
  targets: Array<{ id: string; value: unknown; unit: string }>;
  deviceType?: 'temperature' | 'onoff';
  hasBinaryControl?: boolean;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  priority?: number;
  currentOn?: boolean;
  evChargingState?: string;
  powerKw?: number;
  expectedPowerKw?: number;
  expectedPowerSource?: 'manual' | 'measured-peak' | 'load-setting' | 'homey-energy' | 'default';
  measuredPowerKw?: number;
  currentTemperature?: number;
  controllable?: boolean;
  managed?: boolean;
  budgetExempt?: boolean;
  available?: boolean;
  zone?: string;
};
