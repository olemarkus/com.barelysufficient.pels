// Unit tests for the binary "Run on solar surplus" dump-load rung (PR-7):
// the producer candidacy predicate (`resolveSurplusOnlyPosture`), the standing
// hold selection (`resolveSurplusHold`), the mixed temperature+binary surplus
// allocator pool (`resolveSurplusEligibility` with injected clocks), the
// `awaitingSolarSurplus` reason adoption in `normalizeShedReasons`, and the
// plan-contract classification of the hold (restore-blocking + paused, never
// starving). Pure functions only — every clock is an injected `nowTs`.
import { describe, expect, it } from 'vitest';
import {
  resolveSurplusEligibility,
  resolveSurplusOnlyPosture,
} from '../../lib/plan/planSurplusAbsorb';
import { resolveSurplusHold } from '../../lib/plan/shedding/surplusHold';
import { normalizeShedReasons } from '../../lib/plan/planReasons';
import {
  createPlanEngineState,
  type PlanEngineState,
} from '../../lib/plan/planState';
import {
  SURPLUS_ABSORB_SETTLE_MS,
} from '../../lib/plan/admission/surplusAbsorb';
import {
  isDeferredRestoreBlockedReason,
  resolveStarvationSuppressionSemantics,
} from '../../lib/planContract/planDecisionSemantics';
import {
  PLAN_REASON_CODES,
  formatDeviceReasonUserFacing,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, buildPlanInputDevice, steppedProfile } from '../utils/planTestUtils';

const AWAITING: DeviceReason = { code: PLAN_REASON_CODES.awaitingSolarSurplus };

// ─── Candidacy: resolveSurplusOnlyPosture ─────────────────────────────────────

const candidateParams = (overrides: Partial<Parameters<typeof resolveSurplusOnlyPosture>[0]> = {}) => ({
  surplusWilling: true,
  hasBinaryControl: true,
  hasStandingDemand: true,
  confirmedNotDrawing: false,
  deviceClass: 'socket',
  targets: [],
  steppedLoadProfile: undefined,
  plainBinaryControlModel: true,
  controllable: true,
  managed: true,
  surplusPoolReachable: true,
  ...overrides,
});

describe('resolveSurplusOnlyPosture (dump-load candidacy)', () => {
  it('admits a willing, managed, controllable plain binary device', () => {
    expect(resolveSurplusOnlyPosture(candidateParams())).toBe(true);
  });

  it.each([
    ['not willing', { surplusWilling: false }],
    ['willing absent', { surplusWilling: undefined }],
    ['no binary control capability', { hasBinaryControl: false }],
    // A charger: its demand arrives with a car, so being off is not going
    // without, and it is not a dump load.
    ['no standing demand', { hasStandingDemand: false }],
    ['stepped-load profile', { steppedLoadProfile: steppedProfile }],
    ['temperature target', { targets: [{ id: 'target_temperature', value: 20, unit: 'C' }] }],
    // Continuous / target-power / non-binary control is pre-resolved at the
    // producer into `plainBinaryControlModel` (the raw targetPowerConfig /
    // controlModel → false mapping is covered by the `toPlanDevice` producer
    // test); the settings-UI gate (`resolveDeviceDetailControlMode !== 'default'`)
    // classifies the same devices out.
    ['not a plain binary control model', { plainBinaryControlModel: false }],
    ['power-limit control off', { controllable: false }],
    ['unmanaged', { managed: false }],
    // Restored guard. This row was deleted when the `meteredPowerSource` gate
    // came out, and the trap it had been holding shut re-opened immediately: a
    // device stamped `surplusOnly` in a home whose pool can never open is held
    // OFF forever by `resolveSurplusHold` — no time-based escape, no UI
    // recourse. The gate is now the honest runtime question
    // (`resolveSurplusPoolReachable`) rather than the source name, but the
    // reason it must exist is unchanged.
    ['surplus pool unreachable', { surplusPoolReachable: false }],
  ])('excludes: %s', (_label, overrides) => {
    expect(resolveSurplusOnlyPosture(candidateParams(overrides))).toBe(false);
  });
});

// ─── Hold selection: resolveSurplusHold ───────────────────────────────────────

const dumpLoad = (id: string, overrides: Parameters<typeof buildPlanInputDevice>[0] = {}) => buildPlanInputDevice({
  id,
  name: `Dump ${id}`,
  deviceType: 'onoff',
  binaryControllable: true,
  surplusOnly: true,
  expectedPowerKw: 1,
  ...overrides,
});

describe('resolveSurplusHold (standing dump-load hold)', () => {
  it('holds a designated device with no eligibility state (restart baseline: held => off)', () => {
    const state = createPlanEngineState(0);
    const { holdIds, reasonById } = resolveSurplusHold({
      devices: [dumpLoad('a')],
      state,
      excludeIds: new Set(),
    });
    expect(holdIds.has('a')).toBe(true);
    expect(reasonById.get('a')).toEqual(AWAITING);
  });

  it('holds a designated device whose eligibility is explicitly false', () => {
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice.a = { eligible: false, sinceMs: 0 };
    const { holdIds } = resolveSurplusHold({ devices: [dumpLoad('a')], state, excludeIds: new Set() });
    expect(holdIds.has('a')).toBe(true);
  });

  it('does not hold an eligible device (the allocator lifted the hold)', () => {
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice.a = { eligible: true, sinceMs: 0 };
    const { holdIds, reasonById } = resolveSurplusHold({
      devices: [dumpLoad('a')],
      state,
      excludeIds: new Set(),
    });
    expect(holdIds.has('a')).toBe(false);
    expect(reasonById.has('a')).toBe(false);
  });

  it('does not hold an OFF eligible device while there is CURRENT surplus (the engage turn-on)', () => {
    // eligible + no release pending = surplus currently covers the draw; the device
    // is off only because its restore has not materialized yet — let it turn on FROM surplus.
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice.a = { eligible: true, sinceMs: 0 };
    const { holdIds } = resolveSurplusHold({
      devices: [dumpLoad('a', { binaryControl: { on: false } })],
      state,
      excludeIds: new Set(),
    });
    expect(holdIds.has('a')).toBe(false);
  });

  it('HOLDS a still-OFF device whose eligible is latched but surplus is gone (release pending)', () => {
    // Codex P2 on #1817: eligible latches through the release settle/dwell after
    // surplus vanishes (`pendingSinceMs` set). A still-OFF device must stay HELD so
    // the generic binary-restore lane cannot turn it on from grid headroom before
    // its ON has materialized on real export.
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice.a = { eligible: true, sinceMs: 0, pendingSinceMs: 1000 };
    const { holdIds, reasonById } = resolveSurplusHold({
      devices: [dumpLoad('a', { binaryControl: { on: false } })],
      state,
      excludeIds: new Set(),
    });
    expect(holdIds.has('a')).toBe(true);
    expect(reasonById.get('a')).toEqual(AWAITING);
  });

  it('lets an already-RUNNING absorbing load ride the release dwell (not held) despite a release pending', () => {
    // A device genuinely running on surplus must not be flapped off by a passing-cloud
    // dip — it rides the settle/dwell until the allocator releases eligibility.
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice.a = { eligible: true, sinceMs: 0, pendingSinceMs: 1000 };
    const { holdIds } = resolveSurplusHold({
      devices: [dumpLoad('a', { binaryControl: { on: true } })],
      state,
      excludeIds: new Set(),
    });
    expect(holdIds.has('a')).toBe(false);
  });

  it('never holds a device without the surplusOnly posture', () => {
    const state = createPlanEngineState(0);
    const plain = buildPlanInputDevice({ id: 'b', deviceType: 'onoff', binaryControllable: true });
    expect(resolveSurplusHold({ devices: [plain], state, excludeIds: new Set() }).holdIds.size).toBe(0);
  });

  it('skips every excluded id (the smart-task precedence union)', () => {
    const state = createPlanEngineState(0);
    // The builder unions forceShedSet, deferredAvoidDeviceIds, release-intent
    // keys, and admittedDeviceIds into one exclude set; the hold must honour
    // membership regardless of which source contributed the id.
    for (const source of ['forceShed', 'deferredAvoid', 'releaseIntent', 'admitted']) {
      const { holdIds } = resolveSurplusHold({
        devices: [dumpLoad(source)],
        state,
        excludeIds: new Set([source]),
      });
      expect(holdIds.size).toBe(0);
    }
  });

  it('produces a byte-stable reason across cycles (no numbers/timestamps)', () => {
    const state = createPlanEngineState(0);
    const first = resolveSurplusHold({ devices: [dumpLoad('a')], state, excludeIds: new Set() });
    const second = resolveSurplusHold({ devices: [dumpLoad('a')], state, excludeIds: new Set() });
    expect(JSON.stringify(first.reasonById.get('a'))).toBe(JSON.stringify(second.reasonById.get('a')));
    // Rebuild-storm guard (f1550cea class): the serialized reason may not embed
    // any digit that could tick between cycles.
    expect(JSON.stringify(first.reasonById.get('a'))).not.toMatch(/\d/);
  });
});

// ─── Allocator: mixed temperature + binary pool ───────────────────────────────

const tempDevice = (id: string, priority: number) => buildPlanInputDevice({
  id,
  name: `Temp ${id}`,
  deviceType: 'temperature',
  currentTemperature: 19,
  expectedPowerKw: 1,
  targets: [{ id: 'target_temperature', value: 20, unit: 'C', min: 0, max: 30, step: 0.5 }],
  priority,
});

const allocatorPass = (params: {
  state: PlanEngineState;
  devices: ReturnType<typeof buildPlanInputDevice>[];
  signedNetKw: number;
  nowTs: number;
  priorities?: Record<string, number>;
  configs?: Record<string, { surplusWilling?: boolean; surplusDelta?: number }>;
  excludeIds?: ReadonlySet<string>;
}) => resolveSurplusEligibility({
  // The rank rides on the device: the producer ranks the whole planned set
  // before the allocator sees it, so a spec that cares about order stamps the
  // devices rather than stubbing a lookup.
  devices: params.devices.map((device) => (
    { ...device, priority: params.priorities?.[device.id] ?? device.priority }
  )),
  state: params.state,
  signedNetKw: params.signedNetKw,
  inferredSurplusKw: 0,
  excludeIds: params.excludeIds,
  getConfig: (deviceId) => params.configs?.[deviceId],
  nowTs: params.nowTs,
});

describe('resolveSurplusEligibility (mixed temp + binary pool)', () => {
  it('admits a binary surplusOnly device with no surplusDelta configured', () => {
    const state = createPlanEngineState(0);
    const devices = [dumpLoad('pump')];
    allocatorPass({ state, devices, signedNetKw: -2, nowTs: 0 });
    allocatorPass({ state, devices, signedNetKw: -2, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(state.surplusEligibilityByDevice.pump?.eligible).toBe(true);
  });

  it('one pool, user priority: the higher-priority temp device claims scarce surplus before the binary load', () => {
    const state = createPlanEngineState(0);
    const devices = [dumpLoad('pump'), tempDevice('tank', 1)];
    const priorities = { tank: 1, pump: 2 };
    const configs = { tank: { surplusWilling: true, surplusDelta: 2 } };
    // Export of 1.5 kW covers ONE 1 kW device (+0.25 reserve), not both.
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: 0, priorities, configs });
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS, priorities, configs });
    expect(state.surplusEligibilityByDevice.tank?.eligible).toBe(true);
    expect(state.surplusEligibilityByDevice.pump?.eligible ?? false).toBe(false);
  });

  it('excludes a smart-task-governed device from allocation so a lower-priority willing device gets the pool', () => {
    // Finding B on #1817: an opted-in dump load with an active smart task must not
    // RESERVE the shared surplus pool ahead of a lower-priority willing device. The
    // 1.5 kW export covers ONE 1 kW load; with the higher-priority pump governed, the
    // lower-priority pump must win instead.
    const state = createPlanEngineState(0);
    const devices = [dumpLoad('pump-hi'), dumpLoad('pump-lo')];
    const priorities = { 'pump-hi': 1, 'pump-lo': 2 };
    const excludeIds = new Set(['pump-hi']);
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: 0, priorities, excludeIds });
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS, priorities, excludeIds });
    expect(state.surplusEligibilityByDevice['pump-hi']?.eligible ?? false).toBe(false);
    expect(state.surplusEligibilityByDevice['pump-lo']?.eligible).toBe(true);
  });

  it('without the smart task, the higher-priority device wins the same pool (control)', () => {
    const state = createPlanEngineState(0);
    const devices = [dumpLoad('pump-hi'), dumpLoad('pump-lo')];
    const priorities = { 'pump-hi': 1, 'pump-lo': 2 };
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: 0, priorities });
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS, priorities });
    expect(state.surplusEligibilityByDevice['pump-hi']?.eligible).toBe(true);
    expect(state.surplusEligibilityByDevice['pump-lo']?.eligible ?? false).toBe(false);
  });

  it('drops latched eligibility when a device becomes smart-task-governed (excluded)', () => {
    // A device eligible one cycle, then governed the next, must lose eligibility so it
    // stops reserving the pool — the lockstep cleanup drops the non-willing entry.
    const state = createPlanEngineState(0);
    const devices = [dumpLoad('pump')];
    allocatorPass({ state, devices, signedNetKw: -2, nowTs: 0 });
    allocatorPass({ state, devices, signedNetKw: -2, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(state.surplusEligibilityByDevice.pump?.eligible).toBe(true);
    allocatorPass({
      state, devices, signedNetKw: -2, nowTs: SURPLUS_ABSORB_SETTLE_MS + 1000, excludeIds: new Set(['pump']),
    });
    expect(state.surplusEligibilityByDevice.pump).toBeUndefined();
  });

  it('with priorities swapped, the binary load wins the same scarce pool', () => {
    const state = createPlanEngineState(0);
    const devices = [dumpLoad('pump'), tempDevice('tank', 2)];
    const priorities = { tank: 2, pump: 1 };
    const configs = { tank: { surplusWilling: true, surplusDelta: 2 } };
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: 0, priorities, configs });
    allocatorPass({ state, devices, signedNetKw: -1.5, nowTs: SURPLUS_ABSORB_SETTLE_MS, priorities, configs });
    expect(state.surplusEligibilityByDevice.pump?.eligible).toBe(true);
    expect(state.surplusEligibilityByDevice.tank?.eligible ?? false).toBe(false);
  });

  it('adds back an engaged binary load\'s measured draw so its own consumption cannot release it', () => {
    const state = createPlanEngineState(0);
    const idle = [dumpLoad('pump')];
    allocatorPass({ state, devices: idle, signedNetKw: -2, nowTs: 0 });
    allocatorPass({ state, devices: idle, signedNetKw: -2, nowTs: SURPLUS_ABSORB_SETTLE_MS });
    expect(state.surplusEligibilityByDevice.pump?.eligible).toBe(true);
    // The pump turned on and now draws its 1 kW: net export collapses to 0.2 kW.
    // Add-back credits the measured draw (pool = 0.2 + 1.0 = 1.2 >= 1.0 bare
    // release bar), so the engagement holds instead of self-releasing.
    const running = [dumpLoad('pump', { measuredPowerKw: 1, currentOn: true })];
    allocatorPass({ state, devices: running, signedNetKw: -0.2, nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000 });
    allocatorPass({
      state,
      devices: running,
      signedNetKw: -0.2,
      nowTs: SURPLUS_ABSORB_SETTLE_MS + 10_000 + SURPLUS_ABSORB_SETTLE_MS,
    });
    expect(state.surplusEligibilityByDevice.pump?.eligible).toBe(true);
  });

  it('prunes eligibility state when the device stops being a candidate', () => {
    const state = createPlanEngineState(0);
    state.surplusEligibilityByDevice.pump = { eligible: true, sinceMs: 0 };
    // Same device, posture revoked (no surplusOnly, no temp config).
    const plain = buildPlanInputDevice({ id: 'pump', deviceType: 'onoff', binaryControllable: true });
    allocatorPass({ state, devices: [plain], signedNetKw: -2, nowTs: 10_000 });
    expect(state.surplusEligibilityByDevice.pump).toBeUndefined();
  });
});

// ─── Reason adoption: normalizeShedReasons ────────────────────────────────────

const normalizeHeld = (params: {
  dev: ReturnType<typeof buildPlanDevice>;
  shedReasons?: Map<string, DeviceReason>;
  guardInShortfall?: boolean;
  inCooldown?: boolean;
  holdIds?: string[];
}) => normalizeShedReasons({
  planDevices: [params.dev],
  shedReasons: params.shedReasons ?? new Map(),
  guardInShortfall: params.guardInShortfall ?? false,
  headroomRaw: 1,
  inCooldown: params.inCooldown ?? false,
  activeOvershoot: false,
  shedCooldownRemainingSec: null,
  surplusHoldReasonById: new Map((params.holdIds ?? ['dev']).map((id) => [id, AWAITING])),
})[0];

describe('awaitingSolarSurplus reason adoption', () => {
  const heldDevice = () => buildPlanDevice({
    id: 'dev',
    plannedState: 'shed',
    reason: { code: PLAN_REASON_CODES.keep, detail: null },
  });

  it('adopts the hold reason for a held device with only the default framing', () => {
    const result = normalizeHeld({ dev: heldDevice() });
    expect(result.reason).toEqual(AWAITING);
  });

  it('is stable across repeated normalizations (no embedded numbers)', () => {
    const first = normalizeHeld({ dev: heldDevice() });
    const second = normalizeHeld({ dev: heldDevice() });
    expect(JSON.stringify(first.reason)).toBe(JSON.stringify(second.reason));
    expect(JSON.stringify(first.reason)).not.toMatch(/\d/);
  });

  it('never overwrites a fresh capacity shed decision', () => {
    const result = normalizeHeld({
      dev: heldDevice(),
      shedReasons: new Map([['dev', { code: PLAN_REASON_CODES.capacity } as DeviceReason]]),
    });
    expect(result.reason.code).toBe(PLAN_REASON_CODES.capacity);
  });

  it('never overwrites the shortfall framing', () => {
    const result = normalizeHeld({ dev: heldDevice(), guardInShortfall: true });
    expect(result.reason.code).toBe(PLAN_REASON_CODES.shortfall);
  });

  it('leaves devices outside the hold set alone', () => {
    const result = normalizeHeld({ dev: heldDevice(), holdIds: ['someone-else'] });
    expect(result.reason.code).toBe(PLAN_REASON_CODES.capacity);
  });

  it('renders the canonical user-facing copy', () => {
    expect(formatDeviceReasonUserFacing(AWAITING)).toBe('Waiting for solar surplus');
  });
});

// ─── Plan-contract classification ─────────────────────────────────────────────

describe('awaitingSolarSurplus plan-contract classification', () => {
  it('blocks a deferred binary_restore (restore-blocking classifier)', () => {
    expect(isDeferredRestoreBlockedReason(AWAITING)).toBe(true);
  });

  it('classifies the hold as paused (a deliberate posture), never starvation-counting', () => {
    expect(resolveStarvationSuppressionSemantics(AWAITING)).toEqual({
      state: 'paused',
      countingCause: null,
      pauseReason: 'awaiting_solar_surplus',
    });
  });
});
