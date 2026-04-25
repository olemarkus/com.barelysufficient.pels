import type { SettingsUiPowerStatus } from '../../../contracts/src/settingsUiApi.ts';
import * as legacyPlan from './planLegacy.ts';
import * as redesignPlan from './planRedesign.ts';
import {
  applySettingsUiVariant,
  getCurrentSettingsUiVariant,
} from './uiVariant.ts';

const getPlanModule = () => (getCurrentSettingsUiVariant() === 'redesign' ? redesignPlan : legacyPlan);

export const setOverviewRedesignEnabled = (enabled: boolean): void => {
  applySettingsUiVariant(enabled === true ? 'redesign' : 'legacy');
};

export const renderPlan = (plan: redesignPlan.PlanSnapshot | null) => {
  getPlanModule().renderPlan(plan as legacyPlan.PlanSnapshot & redesignPlan.PlanSnapshot);
};

export const updatePlanPower = (power: SettingsUiPowerStatus | null): void => {
  getPlanModule().updatePlanPower(power);
};

export const refreshPlan = async () => {
  await getPlanModule().refreshPlan();
};

export { parsePlanSnapshot } from './planRedesign.ts';
export type { PlanSnapshot } from './planRedesign.ts';
export { getStoredOverviewRedesignPreference, setStoredOverviewRedesignPreference } from './uiVariant.ts';
