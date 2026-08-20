import type { AppContext } from '../lib/app/appContext';
import { resolveValidTargetPowerReachability } from '../lib/device/targetPowerReachability';
import { normalizeError } from '../lib/utils/errorUtils';
import type { TargetPowerReachabilityState } from '../packages/contracts/src/types';
import { writeTargetPowerReachabilityForApp } from './targetPowerReachabilitySettings';
import { resolvePlanService } from './appInit/contextGuards';

const PERSISTENCE_RETRY_MS = 60 * 1000;

/** Connect runtime reachability feedback and clocks without expanding app.ts. */
export const createTargetPowerReachabilityAppWiring = (
  ctx: AppContext,
  // Same reason the wiring's own `rebuildOwningHomePlanForDevice` resolves
  // rather than asserts: the only caller is a fire-and-forget `void`, and this
  // fallback covers an even earlier window — before `AppServiceWiring` has
  // assigned the ctx member at all.
  rebuildOwningHomePlanForDevice = (
    deviceId: string,
    reason: string,
  ): Promise<unknown> => {
    const routed = ctx.rebuildOwningHomePlanForDevice?.(deviceId, reason);
    if (routed) return routed;
    const resolved = resolvePlanService(ctx);
    if (resolved.state !== 'ready') return Promise.resolve();
    return resolved.planService.rebuildPlanFromCache(reason);
  },
) => {
  const pendingPersistenceByDevice = new Map<string, TargetPowerReachabilityState>();
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined;

  const schedulePersistenceRetry = (): void => {
    if (persistenceTimer || pendingPersistenceByDevice.size === 0) return;
    const timer = setTimeout(() => {
      if (persistenceTimer !== timer) return;
      ctx.timers.clear('targetPowerReachabilityPersistence');
      persistenceTimer = undefined;
      for (const [deviceId, reachability] of pendingPersistenceByDevice) {
        const result = writeTargetPowerReachabilityForApp(ctx, deviceId, reachability);
        if (result.persistence !== 'unavailable') {
          pendingPersistenceByDevice.delete(deviceId);
        }
      }
      schedulePersistenceRetry();
    }, PERSISTENCE_RETRY_MS);
    persistenceTimer = ctx.timers.registerTimeout('targetPowerReachabilityPersistence', timer);
  };

  const updateTargetPowerReachability = (
    deviceId: string,
    state: TargetPowerReachabilityState,
  ): boolean => {
    const result = writeTargetPowerReachabilityForApp(ctx, deviceId, state);
    if (result.persistence === 'unavailable') {
      pendingPersistenceByDevice.set(deviceId, state);
      schedulePersistenceRetry();
    } else {
      pendingPersistenceByDevice.delete(deviceId);
    }
    if (result.applied) {
      ctx.snapshotHelpers.scheduleTargetPowerProbe();
      void rebuildOwningHomePlanForDevice(deviceId, 'target_power_reachability_updated')
        .catch((error: unknown) => ctx.getStructuredLogger('devices')?.error({
          event: 'target_power_reachability_rebuild_failed',
          deviceId,
          err: normalizeError(error),
        }));
    }
    return result.applied;
  };

  return {
    snapshotDeps: {
      reconcileTargetPowerReachability: (snapshot: Parameters<
        AppContext['deviceControlHelpers']['reconcileTargetPowerReachability']
      >[0], nowMs: number) => ctx.deviceControlHelpers.reconcileTargetPowerReachability(snapshot, nowMs),
      getNextTargetPowerProbe: () => {
        const eligibleDeviceIds = new Set((ctx.deviceManager?.getSnapshot() ?? [])
          .filter((device) => ctx.resolveManagedState(device.id) && ctx.isCapacityControlEnabled(device.id))
          .map((device) => device.id));
        const dueProbes = Object.entries(ctx.deviceTargetPowerConfigs).flatMap(([deviceId, config]) => {
          if (!eligibleDeviceIds.has(deviceId)) return [];
          const dueAtMs = resolveValidTargetPowerReachability(config)?.nextProbeAtMs;
          return dueAtMs === undefined ? [] : [{ deviceId, dueAtMs }];
        });
        return dueProbes.length === 0
          ? undefined
          : dueProbes.reduce((earliest, candidate) => (
            candidate.dueAtMs < earliest.dueAtMs ? candidate : earliest
          ));
      },
      rebuildOwningHomePlanForDevice,
      hasPendingTargetPowerProbe: (): boolean => (
        ctx.deviceControlHelpers.hasPendingTargetPowerProbe()
      ),
    },
    deviceControlDeps: {
      getTargetPowerConfig: (deviceId: string) => ctx.deviceTargetPowerConfigs[deviceId],
      updateTargetPowerReachability,
      reportFlowSteppedLoadObservation: (params: Parameters<
        NonNullable<AppContext['deviceManager']>['reportFlowSteppedLoadObservation']
      >[0]) => ctx.deviceManager?.reportFlowSteppedLoadObservation(params) ?? false,
      scheduleTargetPowerProbeSettlement: (dueAtMs: number): void => {
        ctx.snapshotHelpers.scheduleTargetPowerProbeSettlement(dueAtMs);
      },
    },
  };
};
