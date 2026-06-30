import {
  CAPACITY_LIMIT_KW,
  DAILY_BUDGET_ENABLED,
  DAILY_BUDGET_KWH,
} from '../lib/utils/settingsKeys';
import { MAX_DAILY_BUDGET_KWH, MIN_DAILY_BUDGET_KWH } from '../lib/dailyBudget/dailyBudgetConstants';
import {
  readFlowNumberArg,
  readFlowStringArg,
} from './flowArgParsers';
import type { FlowCardDeps } from './registerFlowCards';

export function registerOperatingModeChangedTrigger(deps: FlowCardDeps): void {
  const operatingModeChangedTrigger = deps.homey.flow.getTriggerCard('operating_mode_changed');
  operatingModeChangedTrigger.registerRunListener(async (args: unknown, state?: unknown) => {
    const chosenMode = deps.resolveModeName(readFlowStringArg(args, 'mode'));
    const stateMode = deps.resolveModeName(readFlowStringArg(state, 'mode'));
    if (!chosenMode || !stateMode) return false;
    return chosenMode.toLowerCase() === stateMode.toLowerCase();
  });
  operatingModeChangedTrigger.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));
}

export function registerCapacityAndModeCards(deps: FlowCardDeps): void {
  const reportPowerCard = deps.homey.flow.getActionCard('report_power_usage');
  reportPowerCard.registerRunListener(async (args: unknown) => {
    const power = readFlowNumberArg(args, 'power');
    if (power === null || power < 0) {
      throw new Error('Power must be a non-negative number (W).');
    }
    await deps.recordPowerSample(power);
    return true;
  });

  const setLimitCard = deps.homey.flow.getActionCard('set_capacity_limit');
  setLimitCard.registerRunListener(async (args: unknown) => {
    const capacityGuard = deps.getCapacityGuard();
    if (!capacityGuard) return false;
    const limit = readFlowNumberArg(args, 'limit_kw');
    if (limit === null || limit <= 0) {
      throw new Error('Limit must be a positive number (kW).');
    }
    const previous = deps.homey.settings.get(CAPACITY_LIMIT_KW);
    deps.homey.settings.set(CAPACITY_LIMIT_KW, limit);
    deps.setCapacityLimit(limit);
    deps.getStructuredLogger('capacity')?.info({
      event: 'capacity_limit_set',
      limitKw: limit,
      previousLimitKw: typeof previous === 'number' ? previous : null,
    });
    return true;
  });

  const setDailyBudgetCard = deps.homey.flow.getActionCard('set_daily_budget_kwh');
  setDailyBudgetCard.registerRunListener(async (args: unknown) => {
    const raw = readFlowNumberArg(args, 'budget_kwh');
    if (raw === null) {
      throw new Error('Daily budget must be a number (kWh).');
    }
    if (raw < 0) {
      throw new Error('Daily budget must be non-negative (kWh).');
    }
    const isDisabling = raw === 0;
    if (!isDisabling && (raw < MIN_DAILY_BUDGET_KWH || raw > MAX_DAILY_BUDGET_KWH)) {
      const errorMessage = `Daily budget must be 0 (to disable) or between ${MIN_DAILY_BUDGET_KWH} `
        + `and ${MAX_DAILY_BUDGET_KWH} kWh.`;
      throw new Error(errorMessage);
    }

    const previousBudget = deps.homey.settings.get(DAILY_BUDGET_KWH);
    const previousEnabled = deps.homey.settings.get(DAILY_BUDGET_ENABLED) === true;
    const nextEnabled = !isDisabling;
    const unchangedBudget = typeof previousBudget === 'number' && previousBudget === raw;
    const unchangedEnabled = previousEnabled === nextEnabled;
    if (unchangedBudget && unchangedEnabled) {
      deps.getStructuredLogger('daily_budget')?.info({
        event: 'daily_budget_flow_updated',
        budgetKwh: raw,
        enabled: previousEnabled,
        changed: false,
      });
      return true;
    }

    deps.homey.settings.set(DAILY_BUDGET_KWH, raw);
    deps.homey.settings.set(DAILY_BUDGET_ENABLED, nextEnabled);
    deps.getStructuredLogger('daily_budget')?.info({
      event: 'daily_budget_flow_updated',
      budgetKwh: raw,
      enabled: nextEnabled,
      changed: true,
    });
    return true;
  });

  const setOperatingModeCard = deps.homey.flow.getActionCard('set_capacity_mode');
  setOperatingModeCard.registerRunListener(async (args: unknown) => {
    const raw = readFlowStringArg(args, 'mode');
    if (!raw) throw new Error('Mode must be provided');
    await deps.handleOperatingModeChange(raw);
    return true;
  });
  setOperatingModeCard.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));

  const hasCapacityCond = deps.homey.flow.getConditionCard('has_capacity_for');
  hasCapacityCond.registerRunListener(async (args: unknown) => {
    const requiredKw = readFlowNumberArg(args, 'required_kw');
    if (requiredKw === null) return false;
    const headroom = deps.getHeadroom();
    if (headroom === null) return false;
    return headroom >= requiredKw;
  });

  const isOperatingModeCond = deps.homey.flow.getConditionCard('is_capacity_mode');
  isOperatingModeCond.registerRunListener(async (args: unknown) => {
    const chosenModeRaw = readFlowStringArg(args, 'mode');
    const chosenMode = deps.resolveModeName(chosenModeRaw);
    if (!chosenMode) return false;
    const activeMode = deps.getCurrentOperatingMode();
    const matches = activeMode.toLowerCase() === chosenMode.toLowerCase();
    if (!matches && chosenModeRaw !== chosenMode) {
      deps.debugStructured({
        event: 'mode_condition_alias_mismatch',
        requestedAlias: chosenModeRaw,
        resolvedMode: chosenMode,
        activeMode,
      });
    }
    return matches;
  });
  isOperatingModeCond.registerArgumentAutocompleteListener('mode', async (query: string) => (
    getModeOptions(deps, query)
  ));
}

function getModeOptions(deps: FlowCardDeps, query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return Array.from(deps.getAllModes())
    .filter((m) => !q || m.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((m) => ({ id: m, name: m }));
}
