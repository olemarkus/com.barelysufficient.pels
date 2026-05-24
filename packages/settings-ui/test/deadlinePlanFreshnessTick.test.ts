import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { PlanInputsCard, type DeadlinePlanPayload } from '../src/ui/views/DeadlinePlan.tsx';
import { deadlineLabels } from '../../shared-domain/src/deadlineLabels.ts';

// Separate file from `deadlinePlanRender.test.ts` so the freshness tests are
// not preceded by other tests in the same module that mount the live `ready`
// payload (and its `HorizonChart` effect, which hits an ECharts subpath the
// JSDOM-aliased shim doesn't fully cover and breaks Preact's effect queue for
// every subsequent render in the file). Mounting `PlanInputsCard` directly
// also lets these tests drive the freshness interval without echarts in the
// tree at all.

const mountIntoBody = (): HTMLElement => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return mount;
};

afterEach(() => {
  document.body.replaceChildren();
});

const buildPlanInputsPayloadWithFreshnessRow = (params: {
  lastAcceptedAtMs: number;
  seededValue: string;
}): DeadlinePlanPayload => ({
  kind: 'ev_soc',
  labels: deadlineLabels('ev_soc'),
  priceUnitLabel: 'kr/kWh',
  hero: {
    chips: [],
    tone: 'good',
    sectionLabel: 'Charging smart task',
    headline: 'On track',
    headlineReason: null,
    subline: 'Garage EV',
    metaLine: 'Auto',
    costMetaLine: null,
    deliveredSoFarLine: null,
    recourse: null,
  },
  timeline: {
    ariaLabel: 'Charging smart task',
    progressFloor: 0,
    progressCeilingValue: 60,
    progressCeilingLabel: '60%',
    deadlineLabel: 'Mon 06',
    hours: [],
  },
  planInputs: {
    perUnitRateLabel: null,
    perUnitRateNote: null,
    maxPowerLabel: null,
    maxPowerNote: null,
    extraPermissionsValue: null,
    provenanceRows: [
      { label: 'Source', value: 'Learned from power readings', tone: null },
      {
        label: 'Latest reading used',
        // Producer-supplied seed deliberately disagrees with the post-tick
        // derivation so a passing assertion proves the view recomputed
        // against `Date.now()`, not that it parroted the seed.
        value: params.seededValue,
        tone: null,
        freshnessOfMs: params.lastAcceptedAtMs,
      },
    ],
  },
});

const findProvenanceRowValue = (mount: HTMLElement, label: string): string | null => {
  const rows = mount.querySelectorAll<HTMLElement>('.plan-inputs__row');
  for (const row of Array.from(rows)) {
    if (row.querySelector('.plan-inputs__row-label')?.textContent === label) {
      return row.querySelector('.plan-inputs__row-value')?.textContent ?? null;
    }
  }
  return null;
};

// Preact schedules `useEffect` callbacks on rAF + setTimeout(35ms) (see
// `node_modules/preact/hooks/src/index.js` `afterNextFrame`), so a synchronous
// render() leaves the effect queue pending behind a ~35ms timer. The tests
// below `await flushEffects()` past that threshold so the freshness interval
// registers (or its cleanup runs) before the assertions read state. 100ms is
// ~3× the `RAF_TIMEOUT` Preact uses internally — comfortable margin without
// inflating test runtime.
const flushEffects = (): Promise<void> => new Promise<void>((resolve) => {
  setTimeout(resolve, 100);
});

type FakeIntervalHandle = {
  id: number;
  callback: () => void;
  ms: number;
};

// Installs a stub `setInterval`/`clearInterval` pair so the test can both
// observe registrations *and* drive the interval callback manually — the view
// reads `Date.now()` inside the callback, so triggering the callback after
// `clockMs` moves is enough to simulate a 60s tick without sleeping the test
// process. `vi.useFakeTimers` / `vi.setSystemTime` are intentionally avoided
// here: they replace `setTimeout` too, which then collides with Preact's
// RAF/setTimeout effect scheduling under JSDOM and silently swallows the
// freshness `useEffect`.
const installFakeInterval = (): {
  intervals: FakeIntervalHandle[];
  cleared: number[];
  restore: () => void;
} => {
  const intervals: FakeIntervalHandle[] = [];
  const cleared: number[] = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let nextId = 1;
  globalThis.setInterval = ((callback: () => void, ms: number) => {
    const id = nextId++;
    intervals.push({ id, callback, ms });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: unknown) => {
    if (typeof id === 'number') cleared.push(id);
  }) as typeof clearInterval;
  return {
    intervals,
    cleared,
    restore: () => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
};

// Filters out JSDOM's internal `setInterval` calls (~16.67 ms — the rAF
// polyfill) so the assertions read only the view's `FRESHNESS_TICK_MS`
// registrations. The view pins to a 60_000 ms cadence; anything else is
// implementation noise from the testing environment.
const FRESHNESS_TICK_MS = 60 * 1000;
const freshnessIntervals = (intervals: FakeIntervalHandle[]): FakeIntervalHandle[] => (
  intervals.filter((entry) => entry.ms === FRESHNESS_TICK_MS)
);
// Asserts the view registered no second-cadence interval — broader than
// `freshnessIntervals(...).toHaveLength(0)` because a future regression
// (e.g. a stray module-level `setInterval` or a second component-local
// timer added to `PlanInputsCard`) would slip past a 60_000-ms-only filter.
const expectNoViewSideIntervals = (intervals: FakeIntervalHandle[]): void => {
  const viewSide = intervals.filter((entry) => entry.ms >= 1_000);
  expect(viewSide).toHaveLength(0);
};

describe('DeadlinePlan plan-inputs freshness tick', () => {
  it('re-derives the "Latest reading used" row when the 60s interval fires instead of freezing on the producer-seeded value', async () => {
    // Regression for the v2.8.0 release-review finding (TODO ~line 1160):
    // `Updated N min ago` was frozen at the value `buildPlanInputs` computed
    // at render time, so a user staring at the Smart-task detail page saw
    // "Updated just now" for the entire session. The view now owns a 60s
    // interval that re-computes the freshness string from the raw timestamp.
    const baseMs = Date.UTC(2026, 4, 24, 12, 0, 0);
    let clockMs = baseMs + 30 * 1000;
    const originalDateNow = Date.now;
    Date.now = () => clockMs;
    const { intervals, restore } = installFakeInterval();
    try {
      const mount = mountIntoBody();
      const payload = buildPlanInputsPayloadWithFreshnessRow({
        lastAcceptedAtMs: baseMs,
        seededValue: 'Updated 9 min ago',
      });
      render(h(PlanInputsCard, { payload }), mount);
      await flushEffects();
      expect(findProvenanceRowValue(mount, 'Latest reading used')).toBe('Updated just now');
      // The freshness `useEffect` registers exactly one 60s interval per
      // mount; the 60s cadence is the contract the bug was filed against.
      const freshness = freshnessIntervals(intervals);
      expect(freshness).toHaveLength(1);

      // Advance the clock and drive the interval callback by hand — what
      // would happen on a real 2-minute wall-clock tick.
      clockMs = baseMs + 2 * 60 * 1000;
      freshness[0].callback();
      await flushEffects();
      expect(findProvenanceRowValue(mount, 'Latest reading used')).toBe('Updated 2 min ago');
    } finally {
      restore();
      Date.now = originalDateNow;
    }
  });

  it('clears the freshness interval when the deadline-plan view unmounts so the timer does not leak', async () => {
    // Cleanup contract: the view returns its `setInterval` cleanup from the
    // `useEffect`, so unmounting must clear the pending timer. Without
    // cleanup the interval would keep firing `setNowMs` on a detached
    // component and leak across SPA navigations.
    const { intervals, cleared, restore } = installFakeInterval();
    try {
      const mount = mountIntoBody();
      const payload = buildPlanInputsPayloadWithFreshnessRow({
        lastAcceptedAtMs: Date.now() - 30 * 1000,
        seededValue: 'Updated just now',
      });
      render(h(PlanInputsCard, { payload }), mount);
      await flushEffects();
      expect(findProvenanceRowValue(mount, 'Latest reading used')).not.toBeNull();
      const freshness = freshnessIntervals(intervals);
      expect(freshness).toHaveLength(1);

      // `render(null, surface)` is Preact's documented unmount path; passing
      // `null` tears the previous tree down and fires every nested cleanup.
      render(null, mount);
      await flushEffects();
      for (const { id } of freshness) {
        expect(cleared).toContain(id);
      }
    } finally {
      restore();
    }
  });

  it('skips the freshness interval entirely when no provenance row carries a timestamp', async () => {
    // Bootstrap-only provenance (a single "Starting estimate" Source row) has
    // no `freshnessOfMs` field, so the view should not arm a timer it would
    // immediately clear. Stubs `setInterval` to assert the no-row branch
    // never registers one — keeps the cost flat for the cold-start case that
    // is the vast majority of EV smart-tasks on day one.
    const { intervals, restore } = installFakeInterval();
    try {
      const mount = mountIntoBody();
      const payload: DeadlinePlanPayload = {
        ...buildPlanInputsPayloadWithFreshnessRow({
          lastAcceptedAtMs: Date.now(),
          seededValue: 'Updated just now',
        }),
        planInputs: {
          perUnitRateLabel: null,
          perUnitRateNote: null,
          maxPowerLabel: null,
          maxPowerNote: null,
          extraPermissionsValue: null,
          provenanceRows: [{ label: 'Source', value: 'Starting estimate', tone: null }],
        },
      };
      render(h(PlanInputsCard, { payload }), mount);
      await flushEffects();
      expect(findProvenanceRowValue(mount, 'Source')).toBe('Starting estimate');
      expectNoViewSideIntervals(intervals);
    } finally {
      restore();
    }
  });
});
