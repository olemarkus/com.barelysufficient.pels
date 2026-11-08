import { planStorageHandBack } from '../../lib/plan/restore/storageHandBack';
import { buildPlanDevice, restoreCycleFixture } from '../utils/planTestUtils';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type { StorageLeverState } from '../../lib/plan/planState';

const lever = (overrides: Partial<StorageLeverState>): StorageLeverState => ({
  setpointW: -500,
  purpose: 'limit',
  increaseDecidedAtMs: 0,
  creditBaseW: 0,
  lastDecreaseAtMs: 0,
  chargeRaisedAtMs: 0,
  lastNeedAtMs: 0,
  preClaimSignedW: -3000,
  ownModeChargeW: 0,
  stepW: 5,
  reading: { kind: 'read' },
  exportPhase: 'L1',
  ...overrides,
});

const handedBack = (held: StorageLeverState): boolean => {
  const state = createPlanEngineState();
  const device = buildPlanDevice({ id: 'battery', phaseFootprint: { kind: 'single', phase: 'L1' } });
  const cycle = {
    ...restoreCycleFixture(new Map([['battery', device]]), state, { nowTs: 10_000 }),
    readPhaseExportRoomKw: () => 0.5,
  };
  planStorageHandBack(cycle, device, held, { availableHeadroom: 10, restoredOneThisCycle: false });
  return cycle.storageHandedBack.has('battery');
};

describe('hand-back from an export-phase hold', () => {
  it('waits while the phase has no room for the discharge its own mode would resume', () => {
    expect(handedBack(lever({}))).toBe(false);
  });

  it('sizes from the live continuous plan instead', () => {
    expect(handedBack(lever({ resumePlan: { setpointW: -800, validUntilMs: 20_000 } }))).toBe(true);
  });

  it('goes back to its own mode once that plan has ended', () => {
    expect(handedBack(lever({ resumePlan: { setpointW: -800, validUntilMs: 5_000 } }))).toBe(false);
  });
});
