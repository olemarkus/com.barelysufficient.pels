import { vi } from 'vitest';
import type PelsApp from '../../app.ts';
import type { ComposedPlanEngine } from '../../setup/appInit/composedPlanEngine';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import { partialDouble } from './partialDouble';

/**
 * Replace the plan builder's structured logger with a capture stub and return
 * the array its `info` events land in. Reaches the builder through the typed
 * element-access seam (`ComposedPlanEngine['builder']['deps']`), so a rename of
 * either private member breaks every capture site loudly instead of silently.
 */
export function capturePlanBuilderStructuredLog(app: PelsApp, includeDebugStructured = false): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const stub: Partial<PinoLogger> = {
    info: ((obj: Record<string, unknown>) => { events.push(obj); }) as PinoLogger['info'],
    warn: vi.fn(),
    error: vi.fn(),
    child: (() => stub) as unknown as PinoLogger['child'],
  };
  const engine = app.planEngine as ComposedPlanEngine;
  const deps = engine['builder']['deps'];
  deps.structuredLog = partialDouble<PinoLogger>(stub);
  if (includeDebugStructured) {
    deps.debugStructured = (obj: Record<string, unknown>) => { events.push(obj); };
  }
  return events;
}
