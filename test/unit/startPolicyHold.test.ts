import { describe, expect, it } from 'vitest';
import { resolveStartPolicyHold } from '../../lib/plan/shedding/startPolicyHold';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { inputDevice } from '../utils/planConvergenceFixtures';
import {
  formatDeviceReason,
  formatDeviceReasonUserFacing,
} from '../../packages/shared-domain/src/planReasonFormatting';
import { resolveDisplayStateKind } from '../../packages/shared-domain/src/planCardGrammar';
import { resolvePlanStateKind } from '../../packages/shared-domain/src/planStateLabels';
import type { DeviceOverviewSnapshot } from '../../packages/shared-domain/src/deviceOverview';
import { partialDouble } from '../helpers/partialDouble';

/** The flat overview shape the card resolvers read, not the plan device. */
const overviewDevice = (fields: {
  plannedState: string; currentState: string;
}): DeviceOverviewSnapshot => (
  partialDouble<DeviceOverviewSnapshot>({
    controllable: true,
    available: true,
    ...fields,
  })
);

/** The card's own two-step: raw kind, then the display downgrade to `Off`. */
const displayKindFor = (fields: { plannedState: string; currentState: string }) => (
  resolveDisplayStateKind({
    kind: resolvePlanStateKind(overviewDevice(fields)),
    reasonCode: PLAN_REASON_CODES.awaitingPelsStart,
    starved: false,
    dryRun: false,
    currentState: fields.currentState,
  })
);

/**
 * The narrow exclusion is the whole design, so it is pinned directly.
 *
 * The solar-surplus hold excludes every device a smart task GOVERNS
 * (`resolveSmartTaskPrecedenceIds`: planned, idle, avoided and force-shed alike).
 * This hold lifts only for the devices a task is actively DRIVING, which deferred
 * admission stamps as `startPolicyHoldLifted` on a `planned` decision. If it used
 * the broad set, a device whose own task had decided to leave it idle this hour
 * would drop out of the hold and the ordinary restore lane could start it — the
 * exact opposite of a baseline of off.
 */
const device = (
  id: string,
  startPolicy: 'unrestricted' | 'pels_only',
  taskDriven = false,
) => inputDevice({
  id,
  name: id,
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
  controllable: false,
  managed: true,
  commandAuthority: startPolicy === 'pels_only',
  startPolicy,
  ...(taskDriven ? { startPolicyHoldLifted: true as const } : {}),
});

describe('resolveStartPolicyHold', () => {
  it('holds a pels_only device no task is driving', () => {
    const result = resolveStartPolicyHold([device('charger', 'pels_only')]);

    expect([...result.holdIds]).toEqual(['charger']);
    expect(result.reasonById.get('charger')).toEqual({ code: PLAN_REASON_CODES.awaitingPelsStart });
  });

  it('never holds an unrestricted device', () => {
    const result = resolveStartPolicyHold([device('charger', 'unrestricted')]);

    expect([...result.holdIds]).toEqual([]);
  });

  it('lifts the hold while a task is actively driving the device', () => {
    const result = resolveStartPolicyHold([device('charger', 'pels_only', true)]);

    expect([...result.holdIds]).toEqual([]);
  });

  it('leaves an unmanaged device alone entirely', () => {
    // Without `managed`, PELS ignores the device whatever else the owner set —
    // and `commandAuthority` is false, so a hold would be an intent PELS could
    // never act on.
    const unmanaged = inputDevice({
      id: 'charger',
      name: 'charger',
      binaryCapabilityId: 'onoff',
      binaryControl: { on: true },
      controllable: false,
      managed: false,
      commandAuthority: false,
      startPolicy: 'pels_only',
    });

    expect([...resolveStartPolicyHold([unmanaged]).holdIds]).toEqual([]);
  });

  it('emits a reason with no numbers, so it is byte-stable across cycles', () => {
    const first = resolveStartPolicyHold([device('charger', 'pels_only')]);
    const second = resolveStartPolicyHold([device('charger', 'pels_only')]);

    expect(JSON.stringify([...first.reasonById]))
      .toBe(JSON.stringify([...second.reasonById]));
  });
});

describe('the start-policy hold has no card copy', () => {
  /**
   * The owner's ruling (2026-09-10): a device its start policy is holding reads
   * `Off` and nothing else. Off is its baseline, not a hold PELS is imposing, so
   * there is no reason line and no new string to keep in step with anything.
   *
   * Pinned because the easy mistake is re-adding copy: every sibling posture has
   * a line, and `awaitingSolarSurplus` — which this code otherwise mirrors
   * exactly — is in `HOLD_REASON_CODES` and says "Waiting for solar surplus".
   */
  it('renders no reason line', () => {
    expect(formatDeviceReasonUserFacing({ code: PLAN_REASON_CODES.awaitingPelsStart })).toBe('');
  });

  /**
   * Asserted through `resolvePlanStateKind`, the function the card actually
   * calls — NOT through `isHoldReasonCode`.
   *
   * An earlier version of this spec asserted only that the code is absent from
   * `HOLD_REASON_CODES` and was named "so the card says Off". That premise does
   * not imply the conclusion: `plannedState` decides the state word first, and a
   * `shed` device reads `Limited` whatever the reason code. The card was reading
   * `Limited — Waiting to resume` the whole time the spec was green, because an
   * empty user-facing string falls through to that fallback line.
   */
  it('reads Off once the device is actually off', () => {
    // `getInactiveReason` flips the held device to `inactive` the moment it is
    // observed off; that is what turns the card from `Limited` into `Off`.
    expect(displayKindFor({ plannedState: 'inactive', currentState: 'off' })).toBe('off');
  });

  it('reads Limited only while PELS is still turning it off', () => {
    // The one cycle between the plan deciding and the device obeying. Honest:
    // PELS is acting on the device right now.
    expect(displayKindFor({ plannedState: 'shed', currentState: 'on' })).toBe('held');
  });

  it('still says something in the internal log, which is not card copy', () => {
    expect(formatDeviceReason({ code: PLAN_REASON_CODES.awaitingPelsStart }))
      .toBe('waiting for a smart task to start it');
  });
});
