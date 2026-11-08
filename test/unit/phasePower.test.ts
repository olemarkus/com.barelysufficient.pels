import { normalizePlanMeta } from '../../lib/plan/planStatusHelpers';
import { buildPlanMeta } from '../utils/planTestUtils';
import { resolvePhasePower, withholdPhaseRoom } from '../../lib/plan/phase/phasePower';
import type { PhaseReading } from '../../lib/power/phaseReading';
import { buildRestoreHeadroomLedger } from '../../lib/plan/restore/headroomLedger';
import {
  phaseBoundedPoolKw, phaseExportPoolKw, phaseRoomFor, resolvePhaseRoomAxis, spendPhaseExport, spendPhaseRoom, swapDonorPhaseShare,
} from '../../lib/plan/phase/phaseRoom';

const FUSE = { kind: 'on', supply: 'three_phase_neutral', amps: 25 } as const;

const healthy = (powers: readonly number[], options: { current?: readonly number[]; signed?: boolean } = {}): PhaseReading => ({
  kind: 'healthy',
  signed: options.signed ?? true,
  acceptedAtMs: 0,
  phases: (['L1', 'L2', 'L3'] as const).map((phase, index) => ({
    phase,
    kw: powers[index]!,
    ...(options.current ? { currentA: options.current[index]! } : {}),
  })) as never,
});

describe('resolvePhasePower', () => {
  it('holds a phase under 90 % of the fuse with power only and 95 % with current', () => {
    const powerOnly = resolvePhasePower(FUSE, healthy([1, 1, 1]), 3);
    expect(powerOnly).toMatchObject({ kind: 'on', phases: [{ targetKw: 5.175 }, {}, {}] });
    const withCurrent = resolvePhasePower(FUSE, healthy([1, 1, 1], { current: [4, 4, 4] }), 3);
    expect(withCurrent.kind === 'on' && withCurrent.phases[0]!.targetKw).toBeCloseTo(5.4625);
  });

  it('reads current as the magnitude and power as the direction', () => {
    const power = resolvePhasePower(FUSE, healthy([4, -1, 0], { current: [26, 5, 0] }), 3);
    expect(power.kind === 'on' && power.phases[0]!.drawKw).toBeCloseTo(5.98);
    expect(power.kind === 'on' && power.phases[0]!.breached).toBe(true);
    expect(power.kind === 'on' && power.phases[1]!.drawKw).toBeCloseTo(-1.15);
  });

  it('never breaches an exporting phase', () => {
    const power = resolvePhasePower(FUSE, healthy([6, -6, -6]), -6);
    expect(power.kind === 'on' && power.phases.map((phase) => phase.breached)).toEqual([true, false, false]);
  });

  it('acts on a current-only meter only while the home imports', () => {
    const unsigned = healthy([6, 6, 6], { signed: false, current: [26, 26, 26] });
    expect(resolvePhasePower(FUSE, unsigned, 18).kind).toBe('on');
    expect(resolvePhasePower(FUSE, unsigned, -1)).toEqual({ kind: 'off' });
  });

  it('is off without a neutral supply, a fuse or a trusted reading', () => {
    expect(resolvePhasePower({ kind: 'off' }, healthy([6, 0, 0]), 6)).toEqual({ kind: 'off' });
    expect(resolvePhasePower({ kind: 'on', supply: 'three_phase_no_neutral', amps: 25 }, healthy([6, 0, 0]), 6))
      .toEqual({ kind: 'off' });
    expect(resolvePhasePower(FUSE, { kind: 'degraded' }, 6)).toEqual({ kind: 'off' });
    expect(resolvePhasePower(FUSE, { kind: 'none' }, 6)).toEqual({ kind: 'off' });
  });
});

describe('phase room', () => {
  const room = resolvePhaseRoomAxis(resolvePhasePower(FUSE, healthy([5, 3, 1]), 9));

  it('takes the band off each phase and answers per footprint', () => {
    // 5.175 target less the 0.4 kW band: L1 has no room left.
    expect(phaseRoomFor(room, { kind: 'single', phase: 'L2' })).toEqual({ kind: 'on', kw: expect.closeTo(1.775) });
    const lowest = phaseRoomFor(room, { kind: 'unknown' });
    expect(lowest.kind === 'on' && lowest.kw).toBeCloseTo(-0.225);
    const all = phaseRoomFor(room, { kind: 'all_three' });
    expect(all.kind === 'on' && all.kw).toBeCloseTo(-0.675);
    expect(phaseRoomFor(room, { kind: 'self_balancing' })).toEqual({ kind: 'off' });
  });

  it('spends a third on each phase for a three-phase device and everything for an unknown one', () => {
    const afterAll = spendPhaseRoom(room, { kind: 'all_three' }, 0.3);
    const afterUnknown = spendPhaseRoom(room, { kind: 'unknown' }, 0.3);
    expect(afterAll.kind === 'on' && afterAll.roomKw.L2).toBeCloseTo(1.675);
    expect(afterUnknown.kind === 'on' && afterUnknown.roomKw.L3).toBeCloseTo(3.475);
    expect(spendPhaseRoom(room, { kind: 'single', phase: 'L3' }, 1).kind === 'on').toBe(true);
  });

  it('narrows the ledger through the phase axis', () => {
    const ledger = buildRestoreHeadroomLedger({
      phase: room, capacity: { kind: 'off' }, grid: { kind: 'on', kw: 10 }, budget: { kind: 'off' },
    });
    const l2 = { budgetExempt: false, phaseFootprint: { kind: 'single', phase: 'L2' } } as const;
    expect(ledger.availableFor(l2)).toBeCloseTo(1.775);
    ledger.commit(l2, 1);
    expect(ledger.availableFor(l2)).toBeCloseTo(0.775);
    expect(ledger.availableFor({ budgetExempt: false, phaseFootprint: { kind: 'self_balancing' } })).toBe(9);
  });
});

describe('withholdPhaseRoom', () => {
  const power = resolvePhasePower(FUSE, healthy([2, 2, 2]), 6);
  const roomOf = (next: typeof power, index: number) => (next.kind === 'on' ? next.phases[index]!.roomKw : Number.NaN);

  it('takes held discharge off the room of the phases it sits on, leaving the draw as measured', () => {
    const single = withholdPhaseRoom(power, { kind: 'single', phase: 'L2' }, 1.5);
    expect(roomOf(single, 1)).toBeCloseTo(roomOf(power, 1) - 1.5);
    expect(roomOf(single, 0)).toBeCloseTo(roomOf(power, 0));
    expect(single.kind === 'on' && single.phases[1]!.drawKw).toBe(2);
    expect(roomOf(withholdPhaseRoom(power, { kind: 'all_three' }, 1.5), 0)).toBeCloseTo(roomOf(power, 0) - 0.5);
    expect(roomOf(withholdPhaseRoom(power, { kind: 'unknown' }, 1.5), 2)).toBeCloseTo(roomOf(power, 2) - 1.5);
  });
});

describe('a swap donor against the target phases', () => {
  const room = { kind: 'on', roomKw: { L1: 0, L2: 3, L3: 3 } } as const;
  const onL1 = { kind: 'single', phase: 'L1' } as const;
  const onL2 = { kind: 'single', phase: 'L2' } as const;
  const all = { kind: 'all_three' } as const;
  const unknown = { kind: 'unknown' } as const;

  it('counts only what lands on the phase the target needs', () => {
    expect(swapDonorPhaseShare(room, onL1, onL1, 2)).toBe(1);
    expect(swapDonorPhaseShare(room, onL1, all, 2)).toBeCloseTo(1 / 3);
    expect(swapDonorPhaseShare(room, onL1, onL2, 2)).toBe(0);
    expect(swapDonorPhaseShare(room, onL1, unknown, 2)).toBe(0);
  });

  it('counts a donor in full when the phases are not what holds the target', () => {
    expect(swapDonorPhaseShare(room, onL2, onL1, 2)).toBe(1);
    expect(swapDonorPhaseShare({ kind: 'off' }, onL1, onL2, 2)).toBe(1);
  });
});

describe('surplus within phase room', () => {
  const room = { kind: 'on', roomKw: { L1: 0.2, L2: 3, L3: 3 } } as const;

  it('bounds the pool by the phase room plus what the device already draws', () => {
    expect(phaseBoundedPoolKw(room, { kind: 'single', phase: 'L1' }, 4, 1)).toBeCloseTo(1.2);
    expect(phaseBoundedPoolKw(room, { kind: 'single', phase: 'L2' }, 2, 0)).toBe(2);
    expect(phaseBoundedPoolKw({ kind: 'off' }, { kind: 'single', phase: 'L1' }, 4, 0)).toBe(4);
  });
});

describe('published phase figures', () => {
  it('are rounded so a few watts do not change the plan signature', () => {
    const meta = buildPlanMeta({
      phase: { kind: 'on', phases: [{ phase: 'L1', drawKw: 5.2049, targetKw: 5.175, roomKw: -0.0299, breached: true, exportBreached: false, exportExcessKw: 0 }] },
    });
    const normalized = normalizePlanMeta(meta);
    expect(normalized.powerIsMeasured && normalized.phase.kind === 'on' && normalized.phase.phases[0]!.drawKw).toBe(5.2);
  });
});

describe('an exporting phase past its target', () => {
  it('is an export breach only with signed readings', () => {
    const power = resolvePhasePower(FUSE, healthy([-6.2, 1, 1]), -4.2);
    expect(power.kind === 'on' && power.phases[0]).toMatchObject({ exportBreached: true, breached: false });
    const unsigned = resolvePhasePower(FUSE, healthy([6.2, 1, 1], { signed: false, current: [27, 4, 4] }), 8);
    expect(unsigned.kind === 'on' && unsigned.phases[0]?.exportBreached).toBe(false);
  });
});

describe('surplus on a phase exporting past its target', () => {
  const remainder = (leftKw: number) => new Map([['L1', leftKw] as const]);

  it('offers what is left of the export to a device on that phase', () => {
    expect(phaseExportPoolKw(remainder(1), { kind: 'single', phase: 'L1' }, { kind: 'off' })).toBe(1);
    expect(phaseExportPoolKw(remainder(1), { kind: 'single', phase: 'L2' }, { kind: 'off' })).toBe(0);
    expect(phaseExportPoolKw(remainder(1), { kind: 'unknown' }, { kind: 'off' })).toBe(0);
  });

  it('holds a three-phase device to the import room of its other phases', () => {
    const room = { kind: 'on', roomKw: { L1: 9, L2: 0.5, L3: 4 } } as const;
    expect(phaseExportPoolKw(remainder(1), { kind: 'all_three' }, room)).toBeCloseTo(1.5);
    expect(phaseExportPoolKw(remainder(1), { kind: 'all_three' }, { kind: 'off' })).toBe(3);
  });

  it('spends the export between consumers', () => {
    const after = spendPhaseExport(remainder(1), { kind: 'single', phase: 'L1' }, 0.7);
    expect(after.get('L1')).toBeCloseTo(0.3);
    expect(spendPhaseExport(after, { kind: 'single', phase: 'L1' }, 1).size).toBe(0);
    expect(spendPhaseExport(remainder(1), { kind: 'all_three' }, 1.5).get('L1')).toBeCloseTo(0.5);
  });
});
