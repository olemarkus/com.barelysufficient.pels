// Mock endpoint responses for the widget harness. Each widget talks to the
// Homey runtime through a tiny set of `homey.api(method, path)` /
// `homey.getSettings()` calls (see each widget's `widget.compose.json` `api`
// block); the harness injects a fake `window.Homey` whose `api` routes here, so
// the widgets run their REAL data path against mock data that lives outside the
// bundle — change a number here, refresh, no rebuild.
//
// Scenarios let one widget be driven through several states from the harness
// controls. `respond(id, scenario, method, path)` returns the payload the
// matching endpoint would; `unknown` routes throw so a missing mock is loud.

const HOUR_MS = 60 * 60 * 1000;

// Fixed narrative evening (today 19:00 local) so a preview's chart hour ticks
// read coherently with its fixed "Scheduled / Ready by" copy.
const eveningBaseMs = () => {
  const base = new Date();
  base.setHours(19, 0, 0, 0);
  return base.getTime();
};

// ── create_smart_task ────────────────────────────────────────────────────────

const tempDevice = (deviceId, deviceName, currentValue, group = 'heating', extra = {}) => ({
  deviceId, deviceName, kind: 'temperature', group, unitSymbol: '°C',
  goalMin: 5, goalMax: 85, goalStep: 0.5, defaultGoal: 65, currentValue, ...extra,
});
const evDevice = (deviceId, deviceName, currentValue) => ({
  deviceId, deviceName, kind: 'ev_soc', group: 'ev_charger', unitSymbol: '%',
  goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80, currentValue,
});

const CREATE_DEVICES = {
  default: [tempDevice('hw', 'Hot water', 48), evDevice('ev', 'Driveway charger', 42)],
  overflow: [
    tempDevice('living', 'Living room', 19.5, 'heating', { goalMax: 30, defaultGoal: 21 }),
    tempDevice('bed', 'Bedroom', 17.2, 'heating', { goalMax: 30, defaultGoal: 18 }),
    tempDevice('bath', 'Bathroom floor', 22.1, 'heating', { goalMax: 35, defaultGoal: 24 }),
    tempDevice('office', 'Office', 20.4, 'heating', { goalMax: 30, defaultGoal: 20 }),
    tempDevice('kids', 'Kids room', 19.1, 'heating', { goalMax: 30, defaultGoal: 20 }),
    tempDevice('hall', 'Hallway', 18.6, 'heating', { goalMax: 30, defaultGoal: 19 }),
    tempDevice('base', 'Basement', 16.0, 'heating', { goalMax: 30, defaultGoal: 17 }),
    tempDevice('guest', 'Guest room', 17.8, 'heating', { goalMax: 30, defaultGoal: 18 }),
    tempDevice('study', 'Study', 20.0, 'heating', { goalMax: 30, defaultGoal: 21 }),
    tempDevice('hw', 'Hot water', 48, 'heating'),
    tempDevice('cabin', 'Cabin water heater', 55, 'heating', { defaultGoal: 60 }),
    tempDevice('garage-w', 'Garage water heater', 50, 'heating', { defaultGoal: 55 }),
    evDevice('ev', 'Driveway charger', 42),
    evDevice('evg', 'Guest charger', 30),
    evDevice('evb', 'Barn charger', 18),
  ],
  cannot_meet: [tempDevice('hw', 'Hot water', 48)],
};

// Jagged overnight spot-price staircase, 19:00 → 07:00 (13 hourly points).
const CREATE_PRICE_CURVE = [92, 79, 74, 63, 59, 66, 51, 44, 48, 69, 81, 107, 119];
const CREATE_SCHEDULED_INDEX = [7, 8]; // the cheap trough → "02:00"/"03:00"

const createPreview = (scenario) => {
  const base = eveningBaseMs();
  const priceSeries = CREATE_PRICE_CURVE.map((price, index) => ({
    startsAtMs: base + index * HOUR_MS, price,
  }));
  if (scenario === 'cannot_meet') {
    // Deadline can't be met: only the first cheap hour is reachable before the
    // 3h deadline, a steep shortfall. The scheduled hour and the deadline both
    // sit inside the rendered window so the band/dots stay on-chart. Still
    // projectable (has an hour), so the widget shows the chart — surfacing the
    // feasibility gap (no "can't finish" copy yet).
    return {
      ok: true,
      deadlineAtMs: base + 3 * HOUR_MS,
      deadlineLabel: 'Today 22:00',
      scheduledWindowLabel: '19:00–20:00',
      estimate: {
        status: 'cannot_meet',
        scheduledHours: [{ startsAtMs: base, plannedKWh: 2 }],
        projectedFinishAtMs: base + 2 * HOUR_MS,
        energyEstimateKWh: 4, energyExpectedKWh: 3.6,
        costEstimate: 2.1, costUnit: 'kr',
        priceSeries: priceSeries.slice(0, 4),
      },
    };
  }
  return {
    ok: true,
    deadlineAtMs: base + 12 * HOUR_MS,
    deadlineLabel: 'Tomorrow 07:00',
    scheduledWindowLabel: '02:00–04:00',
    estimate: {
      status: 'on_track',
      scheduledHours: CREATE_SCHEDULED_INDEX.map((index) => ({ startsAtMs: base + index * HOUR_MS, plannedKWh: 2 })),
      projectedFinishAtMs: base + 9 * HOUR_MS,
      energyEstimateKWh: 4, energyExpectedKWh: 3.6,
      costEstimate: 4.2, costUnit: 'kr',
      priceSeries,
    },
  };
};

// ── starvation_rescue ────────────────────────────────────────────────────────

const STARVATION_DEVICES = {
  default: [
    { deviceId: 'hw', deviceName: 'Hot water', cause: 'budget', accumulatedMs: 42 * 60_000, intendedNormalTargetC: 65 },
    { deviceId: 'rad', deviceName: 'Living room', cause: 'capacity', accumulatedMs: 11 * 60_000, intendedNormalTargetC: 21 },
  ],
  all: [
    { deviceId: 'hw', deviceName: 'Hot water', cause: 'budget', accumulatedMs: 42 * 60_000, intendedNormalTargetC: 65 },
    { deviceId: 'rad', deviceName: 'Living room', cause: 'capacity', accumulatedMs: 11 * 60_000, intendedNormalTargetC: 21 },
    { deviceId: 'floor', deviceName: 'Bathroom floor', cause: 'manual', accumulatedMs: 0, intendedNormalTargetC: 24 },
    { deviceId: 'ev', deviceName: 'Driveway charger', cause: 'external', accumulatedMs: 24 * 60_000, intendedNormalTargetC: null },
  ],
  empty: null,
};

const starvationPreview = () => {
  const base = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS;
  return {
    ok: true,
    deadlineAtMs: base + 3 * HOUR_MS,
    deadlineLabel: 'Today 23:00',
    scheduledWindowLabel: '20:00–22:00',
    estimate: {
      status: 'on_track',
      scheduledHours: [{ startsAtMs: base, plannedKWh: 1.5 }, { startsAtMs: base + HOUR_MS, plannedKWh: 1.5 }],
      projectedFinishAtMs: base + 2 * HOUR_MS,
      energyEstimateKWh: 3, energyExpectedKWh: 2.7, costEstimate: 3.1, costUnit: 'kr',
    },
  };
};

// ── headroom ─────────────────────────────────────────────────────────────────

const HEADROOM = {
  under: { state: 'ready', currentKw: 3.2, hourBudgetKw: 7, headroomKw: 3.8, shedCount: 2, priceLevel: 'cheap', limitState: 'under', stale: false },
  near: { state: 'ready', currentKw: 6.3, hourBudgetKw: 7, headroomKw: 0.7, shedCount: 2, priceLevel: 'normal', limitState: 'near', stale: false },
  at_pace: { state: 'ready', currentKw: 7, hourBudgetKw: 7, headroomKw: 0, shedCount: 3, priceLevel: 'expensive', limitState: 'at_pace', stale: false },
  over_cap: { state: 'ready', currentKw: 8.4, hourBudgetKw: 7, headroomKw: 0, shedCount: 4, priceLevel: 'expensive', limitState: 'over_cap', stale: false },
};

// ── smart_tasks ──────────────────────────────────────────────────────────────

const SMART_TASKS = {
  default: {
    state: 'ready', overflowCount: 1,
    rows: [
      { deviceId: 'dryer', deviceName: 'Dryer', kind: 'temperature', unitSymbol: '°C', currentValue: 38, targetValue: 55, finishLabel: '04:30', statusLabel: 'Cannot finish', tone: 'danger', etaVerb: 'Due', targetActionVerb: 'Heat to', targetNoun: 'Target', deadlineLongLabel: 'Tomorrow 04:30', planMetaLabel: null, confidenceLabel: null, whyLabel: 'Today’s daily budget runs out before the deadline.', recourseHint: 'Lower the daily budget so future days reserve power earlier.' },
      { deviceId: 'hw', deviceName: 'Hot water', kind: 'temperature', unitSymbol: '°C', currentValue: 42, targetValue: 55, finishLabel: '05:30', statusLabel: 'At risk', tone: 'warn', etaVerb: 'Ready by', targetActionVerb: 'Heat to', targetNoun: 'Target', deadlineLongLabel: 'Tomorrow 05:30', planMetaLabel: 'Estimate ≈2h 15m · 1.8 kW · ≈4.0 kWh', confidenceLabel: null, whyLabel: 'Limited time left before the deadline.', recourseHint: null },
      { deviceId: 'bed', deviceName: 'Bedroom heat', kind: 'temperature', unitSymbol: '°C', currentValue: null, targetValue: 22, finishLabel: '07:00', statusLabel: 'Building plan…', tone: 'muted', etaVerb: 'Ready by', targetActionVerb: 'Heat to', targetNoun: 'Target', deadlineLongLabel: 'Tomorrow 07:00', planMetaLabel: null, confidenceLabel: null, whyLabel: 'Waiting for tomorrow’s prices.', recourseHint: null },
    ],
    endedRows: [
      // A Missed run carries outcomeTone 'warn' — exercises that the active
      // warn/danger value tint does NOT leak into the calm history group.
      { id: 'hist-dryer-1', deviceId: 'dryer', deviceName: 'Dryer', unitSymbol: '°C', targetValue: 55, targetActionVerb: 'Heat to', outcomeLabel: 'Missed', outcomeTone: 'warn', finishedLabel: 'Today 04:30', progressLabel: '38 → 49 °C · target 55 °C', reachedAtLabel: null, whyLabel: 'Ran out of budget before the deadline.', recourseHint: null, chart: null },
    ],
  },
  empty: { state: 'empty', subtitle: 'No smart tasks yet' },
};

// ── plan_budget ──────────────────────────────────────────────────────────────

const buildBucketLabels = () => Array.from({ length: 24 }, (_v, i) => String(i).padStart(2, '0'));
const PLAN_BUDGET = {
  today: {
    state: 'ready', target: 'today', dateKey: '2026-03-19', bucketLabels: buildBucketLabels(),
    plannedKwh: [0.42, 0.38, 0.36, 0.35, 0.34, 0.38, 0.45, 0.58, 0.7, 0.82, 0.9, 0.94, 0.88, 0.8, 0.74, 0.68, 0.72, 0.85, 1.02, 1.14, 1.08, 0.88, 0.66, 0.51],
    actualKwh: [0.39, 0.37, 0.33, 0.35, 0.31, 0.4, 0.48, 0.61, 0.69, 0.8, 0.87, null, null, null, null, null, null, null, null, null, null, null, null, null],
    showActual: true,
    priceSeries: [92, 88, 81, 79, 84, 95, 103, 118, 126, 132, 136, 128, 119, 111, 108, 114, 127, 144, 156, 162, 149, 131, 118, 104],
    hasPriceData: true, currentIndex: 10, showNow: true, labelEvery: 4, maxPlan: 1.14, priceMin: 79, priceMax: 162, priceAxisUnit: 'øre/kWh',
    projectedKwh: 16.8, projectedCost: 19.6, costUnit: 'kr', summaryTone: 'on_track',
  },
};

// ── router ───────────────────────────────────────────────────────────────────

export const WIDGETS = [
  { id: 'create_smart_task', label: 'New smart task', height: 380, scenarios: ['default', 'overflow', 'cannot_meet'] },
  { id: 'headroom', label: 'Available power', height: 100, scenarios: ['under', 'near', 'at_pace', 'over_cap'] },
  { id: 'plan_budget', label: 'Budget and Price', height: 560, scenarios: ['today'] },
  { id: 'smart_tasks', label: 'Smart tasks', height: 220, scenarios: ['default', 'empty'] },
  { id: 'starvation_rescue', label: 'Get power now', height: 240, scenarios: ['default', 'all', 'empty'] },
];

const devicesPayload = (devices) => (devices === null ? { state: 'empty', subtitle: 'Nothing held back right now' } : { state: 'ready', devices });

export const settings = () => ({});

export const respond = (id, scenario, method, path) => {
  const route = `${method} ${path.split('?')[0]}`;
  if (id === 'create_smart_task') {
    if (route === 'GET /devices') return { state: 'ready', devices: CREATE_DEVICES[scenario] ?? CREATE_DEVICES.default };
    if (route === 'POST /preview') return createPreview(scenario);
    if (route === 'POST /create') return { ok: true };
  }
  if (id === 'starvation_rescue') {
    if (route === 'GET /devices') return devicesPayload(STARVATION_DEVICES[scenario] ?? STARVATION_DEVICES.default);
    if (route === 'POST /preview') return starvationPreview();
    if (route === 'POST /rescue') return { ok: true };
  }
  if (id === 'headroom' && route === 'GET /headroom') return HEADROOM[scenario] ?? HEADROOM.under;
  if (id === 'smart_tasks' && route === 'GET /smart_tasks') return SMART_TASKS[scenario] ?? SMART_TASKS.default;
  if (id === 'plan_budget' && route.startsWith('GET /chart')) return PLAN_BUDGET.today;
  throw new Error(`[harness] no mock for ${id} ${route} (scenario=${scenario})`);
};
