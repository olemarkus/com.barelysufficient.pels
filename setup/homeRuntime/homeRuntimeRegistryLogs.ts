/**
 * The structured-log vocabulary of `HomeRuntimeRegistry`, sliced out of
 * `homeRuntimeRegistry.ts` to keep that entry point under the line budget and
 * to keep the event names + `detail` wording of the registry's five reportable
 * conditions in one place (the same reason `lib/plan/planLogging.ts` exists).
 *
 * Every emitter is a no-op when the `homes` logger is unavailable, exactly as
 * the optional-chained call sites were. Event names and payload shapes are
 * byte-for-byte what the registry emitted inline — log audits keyed on them
 * keep matching.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { SubHomeConfig } from '../../lib/home/homeConfig';
import type { PowerSource } from '../../lib/power/powerSource';
import { normalizeError } from '../../lib/utils/errorUtils';

/**
 * Sub-home bundles are driven ONLY by the per-meter fan-out of the
 * `manager/energy/live` poll, which never runs under `power_source = flow`.
 * The caller edge-triggers this so it logs once per transition into the
 * misconfigured state, not on every reconcile.
 */
export function logSubHomesUnderFlowSource(ctx: AppContext, subHomeCount: number): void {
  ctx.getStructuredLogger('homes')?.warn({
    event: 'sub_homes_configured_under_flow_power_source',
    subHomeCount,
    detail: 'sub-home meters are only sampled by the Homey Energy poll; under '
      + 'power_source=flow they receive no samples and never actuate',
  });
}

/** A suffixed write arrived for a homeId with no live bundle (transient). */
export function logHomeScopedSettingForUnknownHome(
  ctx: AppContext,
  homeId: string,
  baseKey: string,
): void {
  ctx.getStructuredLogger('homes')?.debug({
    event: 'home_scoped_setting_for_unknown_home',
    homeId,
    baseKey,
    detail: 'transient — reconciled against the registry, no bundle exists',
  });
}

/** A meter-identity replacement could not clear the old meter's durable freshness. */
export function logIncompleteIdentityTransition(ctx: AppContext, home: SubHomeConfig): void {
  ctx.getStructuredLogger('homes')?.warn({
    event: 'home_meter_identity_transition_incomplete',
    homeId: home.homeId,
    meterDeviceId: home.meterDeviceId,
    detail: 'durable meter freshness reset failed; old runtime remains fenced until retry',
  });
}

/** A per-home UI read threw; the caller is told `unavailable` rather than failing. */
export function logHomeReadFailed(ctx: AppContext, homeId: string, error: unknown): void {
  ctx.getStructuredLogger('homes')?.warn({
    event: 'home_runtime_read_failed',
    homeId,
    detail: 'already-committed read threw; reported unavailable',
    err: normalizeError(error),
  });
}

/** Constructing the replacement bundle threw; the old runtime stays fenced. */
export function logBundleReplacementFailure(
  ctx: AppContext,
  home: SubHomeConfig,
  error: unknown,
): void {
  ctx.getStructuredLogger('homes')?.error({
    event: 'home_meter_identity_transition_incomplete',
    homeId: home.homeId,
    meterDeviceId: home.meterDeviceId,
    detail: 'bundle replacement failed; old runtime remains fenced until retry',
    err: normalizeError(error),
  });
}

/**
 * A power-source transition could not be completed; every runtime stays fenced
 * until the bounded retry. Discriminated on an explicit `cause` rather than on
 * the presence of `error`: a thrown `undefined` would otherwise silently
 * downgrade the level and swap the `detail` string.
 */
export type PowerSourceTransitionFailure =
  | { generation: number; powerSource: PowerSource; cause: 'freshness_reset' }
  | { generation: number; powerSource: PowerSource; cause: 'bundle_replacement'; error: unknown };

export function logPowerSourceTransitionIncomplete(
  ctx: AppContext,
  params: PowerSourceTransitionFailure,
): void {
  const logger = ctx.getStructuredLogger('homes');
  if (!logger) return;
  const base = {
    event: 'home_power_source_transition_incomplete',
    generation: params.generation,
    powerSource: params.powerSource,
  };
  if (params.cause === 'freshness_reset') {
    logger.warn({
      ...base,
      detail: 'durable meter freshness reset failed; runtimes remain fenced until retry',
    });
    return;
  }
  logger.error({
    ...base,
    detail: 'bundle replacement failed; runtimes remain fenced until retry',
    err: normalizeError(params.error),
  });
}
