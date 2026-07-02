// Overview card copy for the "Run on solar surplus" dump-load posture:
// a HELD dump load reads "Waiting for solar surplus" (via the normal reason
// pipeline from the `awaiting_solar_surplus` reason code), and an ACTIVE one
// running on export reads "On to use your solar power" (the surplus-active
// line). Vocabulary source: notes/ui-terminology.md § Solar surplus vocabulary.
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import type { PlanDeviceSnapshot } from '../src/ui/planTypes.ts';
import { PLAN_REASON_CODES } from '../../shared-domain/src/planReasonSemanticsCore.ts';
import {
  BINARY_SURPLUS_ACTIVE_REASON,
} from '../../shared-domain/src/planTemperatureCardText.ts';
import { PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS } from '../../shared-domain/src/planStateLabels.ts';

const callApi = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  invalidateApiCache: vi.fn(),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/planRedesign.ts', () => ({ bumpPlanSurface: vi.fn() }));

const { PlanGenericCard } = await import('../src/ui/views/PlanDeviceCards.tsx');

const buildDumpLoad = (overrides: Partial<PlanDeviceSnapshot> = {}): PlanDeviceSnapshot => ({
  id: 'pump-1',
  name: 'Pool Pump',
  controlModel: 'binary_power',
  controllable: true,
  reason: { code: PLAN_REASON_CODES.none },
  ...overrides,
} as PlanDeviceSnapshot);

const renderCard = (dev: PlanDeviceSnapshot, dryRun = false): HTMLDivElement => {
  const mount = document.createElement('div');
  act(() => {
    render(h(PlanGenericCard, { dev, plan: null, dryRun, renderedAtMs: 1_000, nowMs: 1_000 }), mount);
  });
  return mount;
};

describe('dump-load Overview card lines', () => {
  it('a held dump load reads "Waiting for solar surplus"', () => {
    const card = renderCard(buildDumpLoad({
      currentState: 'off',
      plannedState: 'shed',
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
    }));
    expect(card.querySelector('.plan-card__reason')?.textContent)
      .toBe(PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS);
    expect(card.textContent).toContain('Waiting for solar surplus');
  });

  it('an active dump load running on export reads "On to use your solar power"', () => {
    const card = renderCard(buildDumpLoad({
      currentState: 'on',
      plannedState: 'keep',
      measuredPowerKw: 1.0,
      surplusAbsorbActive: true,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    }));
    expect(card.querySelector('.plan-card__reason')?.textContent).toBe(BINARY_SURPLUS_ACTIVE_REASON);
  });

  it('never claims the surplus line on a held card even if a stale active flag rides in', () => {
    // Defense-in-depth mirror of the shared resolver's `kind === 'active'` gate:
    // a held card must show the hold reason, not the running claim.
    const card = renderCard(buildDumpLoad({
      currentState: 'off',
      plannedState: 'shed',
      surplusAbsorbActive: true,
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
    }));
    expect(card.querySelector('.plan-card__reason')?.textContent)
      .toBe(PLAN_STATE_AWAITING_SOLAR_SURPLUS_STATUS);
  });

  it('an ordinary running device without the posture shows no surplus line', () => {
    const card = renderCard(buildDumpLoad({
      currentState: 'on',
      plannedState: 'keep',
      measuredPowerKw: 1.0,
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
    }));
    expect(card.textContent).not.toContain(BINARY_SURPLUS_ACTIVE_REASON);
  });

  it('a held dump load STILL reporting load (manual-on) reads the surplus reconcile, not "after pause"', () => {
    // The user flipped the pump on by hand while it is surplus-held: the card is
    // in the reported-load-conflict state (held + measured > 0.05). It must NOT
    // read "Still reporting N kW after pause" (a baseline-off device was never
    // paused) — it names the surplus reconcile instead.
    const card = renderCard(buildDumpLoad({
      currentState: 'on',
      plannedState: 'shed',
      measuredPowerKw: 1.0,
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
    }));
    const reason = card.querySelector('.plan-card__reason')?.textContent ?? '';
    expect(reason).toBe('Still reporting 1.0 kW — switching off to wait for solar surplus');
    expect(reason).not.toContain('after pause');
  });

  it('states the surplus reconcile hypothetically in simulation mode', () => {
    // Dry-run: PELS never actually switches the dump load off, so the copy must
    // read "would switch off", not assert an action that did not happen.
    const card = renderCard(buildDumpLoad({
      currentState: 'on',
      plannedState: 'shed',
      measuredPowerKw: 1.0,
      reason: { code: PLAN_REASON_CODES.awaitingSolarSurplus, detail: null },
    }), true);
    const reason = card.querySelector('.plan-card__reason')?.textContent ?? '';
    expect(reason).toBe('Still reporting 1.0 kW — would switch off to wait for solar surplus');
  });
});
