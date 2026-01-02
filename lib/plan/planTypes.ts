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
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  currentTemperature?: number;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
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
  priority?: number;
  currentOn?: boolean;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  currentTemperature?: number;
  controllable?: boolean;
  managed?: boolean;
  zone?: string;
};
