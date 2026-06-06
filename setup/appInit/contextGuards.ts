import type { AppContext } from '../../lib/app/appContext';
import type { FlowHomeyLike } from '../../lib/utils/types';

/**
 * AppContext dependency-presence guards. Each `require*` asserts that a service
 * the wiring order is supposed to have already constructed is actually present,
 * surfacing the canonical "must be initialized" error at the wiring seam rather
 * than a downstream `undefined` dereference. Shared by the service factories and
 * the flow-card registrar.
 */

export function requireDeviceManager(ctx: AppContext) {
  if (!ctx.deviceManager) {
    throw new Error('DeviceTransport must be initialized before plan engine setup.');
  }
  return ctx.deviceManager;
}

export function requirePlanEngine(ctx: AppContext) {
  if (!ctx.planEngine) {
    throw new Error('PlanEngine must be initialized before plan service setup.');
  }
  return ctx.planEngine;
}

export function requirePlanService(ctx: AppContext) {
  if (!ctx.planService) {
    throw new Error('PlanService must be initialized before price coordinator wiring.');
  }
  return ctx.planService;
}

export function requireDailyBudgetService(ctx: AppContext) {
  if (!ctx.dailyBudgetService) {
    throw new Error('DailyBudgetService must be initialized before flow card registration.');
  }
  return ctx.dailyBudgetService;
}

export function requireFlowHomey(ctx: AppContext): FlowHomeyLike {
  const { homey } = ctx;
  if (
    typeof homey.flow?.getTriggerCard !== 'function'
    || typeof homey.flow?.getConditionCard !== 'function'
    || typeof homey.flow?.getActionCard !== 'function'
    || typeof homey.settings?.get !== 'function'
    || typeof homey.settings?.set !== 'function'
  ) {
    throw new Error('Flow card registration requires Homey flow and settings APIs.');
  }
  return homey as unknown as FlowHomeyLike;
}
