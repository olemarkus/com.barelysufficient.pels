/*
 * Startup probe for the native-wiring flow-conflict initiative (PR1).
 *
 * Reads the owner's configured Homey Flows once and structured-logs how many
 * device-capability writes exist across them. This is telemetry only — it
 * does not change any device, setting, or plan. Its purpose is to surface the
 * real shape and volume of user-flow capability writes in production before
 * later PRs use that signal to gate native-wiring auto-enable.
 *
 * Best-effort by design: the read fails closed (see readUserFlows), and the
 * caller invokes this fire-and-forget so a slow or failing Web API never
 * blocks or fails app startup.
 */
import type { Logger as PinoLogger } from 'pino';
import { readFlowCapabilityWrites, type FlowApiGet } from '../lib/flowApi/readUserFlows';

export async function runFlowConflictProbe(deps: {
  get: FlowApiGet;
  structuredLog?: PinoLogger;
}): Promise<void> {
  const result = await readFlowCapabilityWrites({ get: deps.get });

  if (result.status === 'unknown') {
    deps.structuredLog?.info({
      event: 'flow_conflict_probe',
      outcome: 'unknown',
      reason: result.reason,
    });
    return;
  }

  let writeCount = 0;
  for (const capabilities of result.writes.values()) {
    writeCount += capabilities.size;
  }

  deps.structuredLog?.info({
    event: 'flow_conflict_probe',
    outcome: 'ok',
    deviceCount: result.writes.size,
    writeCount,
  });
}
