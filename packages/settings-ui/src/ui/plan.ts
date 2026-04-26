import type { SettingsUiPowerStatus } from '../../../contracts/src/settingsUiApi.ts';
import * as legacyPlan from './planLegacy.ts';

const getPlanModule = () => legacyPlan;

export const renderPlan = (plan: legacyPlan.PlanSnapshot | null) => {
  getPlanModule().renderPlan(plan);
};

export const refreshPlan = async () => {
  await getPlanModule().refreshPlan();
};

export const updatePlanPower = (power: SettingsUiPowerStatus | null): void => {
  getPlanModule().updatePlanPower(power);
};

export const parsePlanSnapshot = (value: unknown): legacyPlan.PlanSnapshot | null => (
  getPlanModule().parsePlanSnapshot(value)
);

export type { PlanSnapshot } from './planLegacy.ts';
