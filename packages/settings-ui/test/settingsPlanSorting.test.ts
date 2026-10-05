import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import { fixtureDeviceReason } from './helpers/fixtureDeviceReason.ts';
import { buildPlanMeta } from './helpers/planMetaFixture.ts';
import { buildHomeyApiMock, emitHomeyEvent, installedHomeyMock, installHomeyMock } from './helpers/homeyApiMock';
import {
  buildDom,
  buildSettingsHomeyState,
  flushPromises,
  installSettingsHomeyMock,
  loadDeviceAndModeSettings,
  loadSettingsScript,
  releasePageResourcesAfterEachTest,
  waitFor,
} from './helpers/settingsPage.ts';

vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));

releasePageResourcesAfterEachTest();

describe('Plan sorting', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    installSettingsHomeyMock({
      planSnapshot: null,
      target_devices_snapshot: [],
    });
  });

  const setupPlanHomeyMock = (planSnapshot: { devices?: { id: string; name: string; priority?: number }[] } | null) => {
    installSettingsHomeyMock({
      planSnapshot: planSnapshot,
      // The Overview renders the DEVICE list joined to the plan, so a plan
      // fixture alone draws no cards. Production's device list is a superset of
      // the plan's devices; mirroring the plan's ids is the faithful minimum.
      target_devices_snapshot: (planSnapshot?.devices ?? []).map((device) => ({
        id: device.id,
        name: device.name,
        priority: device.priority,
        targets: [],
        available: true,
      })),
      // Simulation OFF: under the card grammar a simulated plan renders the
      // FACTUAL device state (nothing is actually held), so held/rescue
      // assertions need real mode.
      capacity_dry_run: false,
    });
  };

  it('sorts devices by priority ascending within each zone (priority 1 = most important, first)', async () => {
    // Note: This test verifies the settings UI sorting - backend sorting is tested in plan.test.ts
    const planSnapshot = {
      meta: buildPlanMeta({
        totalKw: 4.2,
        softLimitKw: 9.5}),
      devices: [
        {
          id: 'dev-1', name: 'Most Important Heater', zone: 'Living Room', priority: 1, currentState: 'heating', plannedState: 'keep',
        },
        {
          id: 'dev-2', name: 'Least Important Heater', zone: 'Living Room', priority: 5, currentState: 'heating', plannedState: 'keep',
        },
        {
          id: 'dev-3', name: 'Medium Priority Heater', zone: 'Living Room', priority: 3, currentState: 'heating', plannedState: 'keep',
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    // Switch to overview tab
    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const planList = document.querySelector('#plan-cards');
    const deviceRows = planList?.querySelectorAll('.plan-card');

    expect(deviceRows?.length).toBe(3);

    // Get device names in order
    const deviceNames = Array.from(deviceRows || []).map(
      (row) => row.querySelector('.plan-card__title')?.textContent,
    );

    // Priority 1 = most important, shown first: 1, 3, 5
    expect(deviceNames).toEqual([
      'Most Important Heater', // priority 1
      'Medium Priority Heater', // priority 3
      'Least Important Heater', // priority 5
    ]);
  });

  it('marks held devices without repeating the limited state chip', async () => {
    const planSnapshot = {
      meta: buildPlanMeta({
        totalKw: 5.1,
        softLimitKw: 7.5}),
      devices: [
        { id: 'a2', name: 'Alpha Two', priority: 2, currentState: 'on', plannedState: 'keep' },
        { id: 'b1', name: 'Bravo One', priority: 1, currentState: 'on', plannedState: 'shed' },
        { id: 'a1', name: 'Alpha One', priority: 1, currentState: 'on', plannedState: 'keep' },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const deviceRows = document.querySelectorAll('#plan-cards .plan-card');
    const deviceNames = Array.from(deviceRows).map(
      (row) => row.querySelector('.plan-card__title')?.textContent,
    );
    expect(deviceNames).toEqual(['Bravo One', 'Alpha One', 'Alpha Two']); // priority order

    const heldCard = document.querySelector('#plan-cards [data-device-id="b1"]') as HTMLElement | null;
    expect(heldCard?.dataset.stateKind).toBe('held');
    expect(heldCard?.querySelector('.plan-state-chip-wrap .plan-chip')).toBeNull();
  });

  it('shows measured and expected power in usage line when available', async () => {
    const planSnapshot = {
      meta: buildPlanMeta({
        totalKw: 3.3,
        softLimitKw: 9.0}),
      devices: [
        {
          id: 'device-1',
          name: 'Heater',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          currentDrawKw: 1.23,
          expectedPowerKw: 2.34,
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const usageLine = document.querySelector('#plan-cards .plan-card__state-power')?.textContent || '';
    expect(usageLine).toBe('1.2 kW');
  });

  it('shows expected draw label when a keep-off device has no live draw', async () => {
    const planSnapshot = {
      meta: buildPlanMeta({
        totalKw: 1.0,
        softLimitKw: 9.0}),
      devices: [
        {
          id: 'device-2',
          name: 'Radiator',
          priority: 1,
          currentState: 'off',
          plannedState: 'keep',
          expectedPowerKw: 1.5,
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const metric = document.querySelector('#plan-cards .plan-card__state-power') as HTMLElement | null;
    expect(metric?.dataset.variant).toBe('expected');
    expect(metric?.textContent).toContain('≈ 1.5 kW when active');
  });

  it('shows expected draw label when on but not drawing power', async () => {
    const planSnapshot = {
      meta: buildPlanMeta({
        totalKw: 2.0,
        softLimitKw: 9.0}),
      devices: [
        {
          id: 'device-3',
          name: 'Idle Thermostat',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          currentDrawKw: 0,
          expectedPowerKw: 0.12,
        },
      ],
    };

    installSettingsHomeyMock({
      planSnapshot: planSnapshot,
      target_devices_snapshot: [],
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const metric = document.querySelector('#plan-cards .plan-card__state-power') as HTMLElement | null;
    expect(metric?.dataset.variant).toBe('expected');
    expect(metric?.textContent).toContain('≈ 0.1 kW when active');
  });

  it('keeps the last rendered plan when a realtime plan update is malformed', async () => {
    const homey = installSettingsHomeyMock({
      planSnapshot: {
        meta: buildPlanMeta({
          totalKw: 2.0,
          softLimitKw: 9.0}),
        devices: [
          {
            id: 'device-1',
            name: 'Heater',
            priority: 1,
            currentState: 'on',
            plannedState: 'keep',
            reason: fixtureDeviceReason('keep'),
          },
        ],
      },
      target_devices_snapshot: [],
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    expect(document.querySelectorAll('#plan-cards .plan-card')).toHaveLength(1);
    expect(document.querySelector('#plan-cards .plan-card__title')?.textContent).toContain('Heater');

    emitHomeyEvent(homey, 'plan_updated', {
      meta: buildPlanMeta({
        totalKw: 2.1,
        softLimitKw: 9.0}),
      devices: [
        {
          id: 'device-1',
          name: 'Heater',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
        },
      ],
    });
    await flushPromises();

    expect(document.querySelectorAll('#plan-cards .plan-card')).toHaveLength(1);
    expect(document.querySelector('#plan-cards .plan-card__title')?.textContent).toContain('Heater');
  });

  it('does not read a persisted plan when capacity priorities change via settings event', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const getSpy = vi.fn((key, cb) => {
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'capacity_priorities') return cb(null, { Home: {} });
      if (key === 'mode_device_targets') return cb(null, { Home: {} });
      if (key === 'controllable_devices') return cb(null, {});
      if (key === 'managed_devices') return cb(null, {});
      if (key === 'price_optimization_settings') return cb(null, {});
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, null);
    });

    installSettingsHomeyMock({
      planSnapshot: {
        meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5}),
        devices: [],
      },
      target_devices_snapshot: [],
      capacity_priorities: { Home: {} },
      mode_device_targets: { Home: {} },
    });
    installedHomeyMock().get = getSpy;
    installedHomeyMock().on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const before = getSpy.mock.calls.filter((call) => call[0] === 'planSnapshot').length;
    const settingsCallbacks = listeners['settings.set'] || [];
    settingsCallbacks.forEach((cb) => cb('capacity_priorities'));
    await flushPromises();

    const after = getSpy.mock.calls.filter((call) => call[0] === 'planSnapshot').length;
    expect(after).toBe(before);
  });

  it('hides the banner on the producer-resolved readings fact, ignoring a stale status blob', async () => {
    // The payload's `readings` is the ONE fact the banner reads: a fresh fact
    // keeps it hidden even when the persisted status blob carries an old
    // stamp (the tracker-vs-status precedence the UI used to re-derive is the
    // producer's job now, and heartbeat is gone from the wire entirely).
    const now = Date.now();
    installedHomeyMock().__uiState.power = {
      tracker: { lastTimestamp: now - 5_000 },
      readings: { state: 'received', lastPowerUpdateMs: now - 5_000 },
      status: { state: 'live', status: { lastPowerUpdate: now - 2 * 60_000, priceLevel: 'cheap' } },
    };

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    expect(banner.hidden).toBe(true);
  });

  it('self-corrects the stale-data banner from slim power_updated without refetching /ui_power', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stalePower = {
      tracker: { lastTimestamp: Date.now() - 2 * 60_000 },
      readings: { state: 'received', lastPowerUpdateMs: Date.now() - 2 * 60_000 },
      status: { state: 'live', status: { lastPowerUpdate: Date.now() - 2 * 60_000, priceLevel: 'cheap' } },
    };

    installedHomeyMock().__uiState = { power: stalePower };
    installedHomeyMock().on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    installedHomeyMock().api = buildHomeyApiMock(installedHomeyMock());

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    expect(banner.hidden).toBe(false);

    (installedHomeyMock().api as ReturnType<typeof vi.fn>).mockClear();
    // The runtime's slim push: status plus the readings stamp, no tracker.
    const freshPower = {
      readings: { state: 'received', lastPowerUpdateMs: Date.now() - 5_000 },
      status: { state: 'live', status: { lastPowerUpdate: Date.now() - 5_000, priceLevel: 'cheap' } },
    };
    const powerCallbacks = listeners.power_updated || [];
    powerCallbacks.forEach((cb) => cb(freshPower));
    await flushPromises();

    expect(banner.hidden).toBe(true);
    const powerGetCalls = (installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('keeps slim power_updated cache entries shaped like /ui_power payloads', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    installedHomeyMock().on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    installedHomeyMock().api = buildHomeyApiMock(installedHomeyMock());

    await loadSettingsScript();

    const { getApiReadModel, invalidateApiCache } = await import('../src/ui/homey.ts');
    invalidateApiCache('/ui_power');

    const freshPower = {
      readings: { state: 'received', lastPowerUpdateMs: Date.now() - 5_000 },
      status: { state: 'live', status: { lastPowerUpdate: Date.now() - 5_000, priceLevel: 'cheap' } },
    };
    (listeners.power_updated || []).forEach((cb) => cb(freshPower));
    await flushPromises();

    // The cache entry keeps the /ui_power SHAPE: the slim push's status and
    // readings land on the empty-tracker seed, which carries no peak yet.
    await expect(getApiReadModel('/ui_power')).resolves.toEqual({
      tracker: {},
      readings: freshPower.readings,
      status: freshPower.status,
      capacityPeak: { state: 'unavailable' },
      capacityScalars: { state: 'unavailable' },
      hardCapConfiguration: { state: 'unavailable' },
    });
    const powerGetCalls = (installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('does not turn rapid slim power_updated events into repeated /ui_power fetches while Usage is visible', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    installedHomeyMock().__uiState = {
      power: {
        tracker: { hourly: {}, daily: {}, lastTimestamp: Date.now() },
        readings: { state: 'received', lastPowerUpdateMs: Date.now() },
        status: { state: 'live', status: { lastPowerUpdate: Date.now(), priceLevel: 'cheap' } },
      },
    };
    installedHomeyMock().on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    installedHomeyMock().api = buildHomeyApiMock(installedHomeyMock());

    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('usage');
    await flushPromises();

    (installedHomeyMock().api as ReturnType<typeof vi.fn>).mockClear();
    const freshPower = {
      readings: { state: 'received', lastPowerUpdateMs: Date.now() },
      status: { state: 'live', status: { lastPowerUpdate: Date.now(), priceLevel: 'cheap' } },
    };
    (listeners.power_updated || []).forEach((cb) => cb(freshPower));
    (listeners.power_updated || []).forEach((cb) => cb({
      ...freshPower,
      status: { state: 'live', status: { lastPowerUpdate: Date.now() + 2_000, priceLevel: 'cheap' } },
    }));
    (listeners.power_updated || []).forEach((cb) => cb({
      ...freshPower,
      status: { state: 'live', status: { lastPowerUpdate: Date.now() + 4_000, priceLevel: 'cheap' } },
    }));
    await flushPromises();

    const powerGetCalls = (installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('invalidates /ui_power cache before periodic stale-data checks', async () => {
    const intervalCallbacks = new Map<number, () => void>();
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((
      callback: () => void,
      ms: number,
    ) => {
      intervalCallbacks.set(ms, callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      const now = Date.now();
      installedHomeyMock().__uiState.power = {
        tracker: { lastTimestamp: now - 5_000 },
        readings: { state: 'received', lastPowerUpdateMs: now - 5_000 },
        status: { state: 'live', status: { lastPowerUpdate: now - 2 * 60_000, priceLevel: 'cheap' } },
      };

      await loadSettingsScript();

      const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
      expect(banner.hidden).toBe(true);

      installedHomeyMock().__uiState.power = {
        tracker: { lastTimestamp: now - 2 * 60_000 },
        readings: { state: 'received', lastPowerUpdateMs: now - 2 * 60_000 },
        status: { state: 'live', status: { lastPowerUpdate: now - 2 * 60_000, priceLevel: 'cheap' } },
      };

      (installedHomeyMock().api as ReturnType<typeof vi.fn>).mockClear();
      const staleInterval = intervalCallbacks.get(30 * 1000);
      expect(typeof staleInterval).toBe('function');
      staleInterval?.();
      await flushPromises();

      expect(banner.hidden).toBe(false);
      const powerGetCalls = (installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
      expect(powerGetCalls.length).toBeGreaterThan(0);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('invalidates /ui_plan cache when reopening overview', async () => {
    await loadSettingsScript();

    (installedHomeyMock().api as ReturnType<typeof vi.fn>).mockClear();

    const budgetTab = document.querySelector('[data-tab="budget"]') as HTMLButtonElement;
    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    budgetTab.click();
    await flushPromises();
    overviewTab.click();
    await flushPromises();

    const planGetCalls = (installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_plan');
    expect(planGetCalls).toHaveLength(1);
  });

  it('returns a Homey-style 404 for API paths not declared in app.json', async () => {
    const api = buildHomeyApiMock(installedHomeyMock());

    const result = await new Promise<{ err: Error | null; value?: unknown }>((resolve) => {
      api('GET', '/definitely_missing_route', {}, (err: Error | null, value?: unknown) => resolve({ err, value }));
    });

    expect(result.value).toBeUndefined();
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toContain('Cannot GET /api/app/com.barelysufficient.pels/definitely_missing_route');
  });

  it('uses the device target step for mode inputs and saves normalized values', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Connected 300',
          deviceType: 'temperature',
          targets: [{ id: 'target_temperature', value: 65, unit: '°C', min: 35, max: 75, step: 5 }],
        },
      ],
      capacity_priorities: { Home: { 'dev-1': 1 } },
      mode_device_targets: { Home: { 'dev-1': 46 } },
      managed_devices: { 'dev-1': true },
      controllable_devices: { 'dev-1': true },
    });
    installedHomeyMock().set = setSpy;

    await loadDeviceAndModeSettings();

    const input = document.querySelector('.mode-target-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.step).toBe('5');
    expect(input?.value).toBe('45');

    if (!input) throw new Error('Expected mode target input');
    input.value = '46';
    input.dispatchEvent(new Event('change'));

    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'mode_device_targets');
      return calls.length > 0;
    }, 1500);

    const calls = setSpy.mock.calls.filter((call) => call[0] === 'mode_device_targets');
    expect(calls[calls.length - 1]?.[1]).toEqual({ Home: { 'dev-1': 45 } });
  });
});

describe('Overview "Let it run now" rescue-gate freshness on tab activation', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    window.localStorage.clear();
  });

  // A budget-held card: cause='budget' + isStarved offers the chip by card data;
  // the server-resolved rescuable gate then decides whether it actually renders.
  const budgetHeldPlan = {
    meta: buildPlanMeta({ totalKw: 2.0, softLimitKw: 9.0}),
    devices: [
      {
        id: 'heater-1',
        name: 'Termostat Synne',
        priority: 1,
        currentState: 'on',
        plannedState: 'shed',
        controllable: true,
        available: true,
        budgetExempt: false,
        starvation: { isStarved: true, accumulatedMs: 5 * 60_000, cause: 'budget', startedAtMs: 0 },
        reason: fixtureDeviceReason('shed due to capacity'),
      },
    ],
  };

  // Mirrors the plan's devices: production's device list is a superset of the
  // plan's, and the Overview joins the two on device id.
  const budgetHeldPlanDevices = budgetHeldPlan.devices.map((device) => withDescriptorIdentity<TargetDeviceSnapshot>({
    id: device.id,
    name: device.name,
    priority: device.priority,
    targets: [],
    available: true,
  } as unknown as TargetDeviceSnapshot));

  const rescueChipButton = (): HTMLButtonElement | null => (
    document.querySelector('#plan-cards .plan-card__rescue button')
  );

  it('refreshes the rescuable gate when Overview opens, so a device held back off-tab shows the chip', async () => {
    // Boot with the device budget-held but NOT yet in the rescuable set (it
    // became rescuable only later, while the user was on another tab).
    const homey = installHomeyMock({
      // Simulation OFF — the "Let it run now" rescue chip is deliberately
      // suppressed in simulation (nothing to release when PELS actuates
      // nothing; see planCardGrammar.ts).
      settings: buildSettingsHomeyState({ capacity_dry_run: false }),
      uiState: {
        // The Overview's cards are device rows now, so the gate's chip needs
        // the device this plan decides about to be in the device list too.
        devices: budgetHeldPlanDevices,
        plan: budgetHeldPlan,
        starvationRescuableDeviceIds: [],
      },
    });

    await loadSettingsScript();
    // Overview is the boot tab; with the empty gate the chip stays hidden.
    await flushPromises();
    expect(rescueChipButton()).toBeNull();

    // Leave Overview, then the gate flips off-tab (the device entered the
    // server-resolved rescuable set). The `plan_updated` gate refresh is
    // Overview-only, so nothing updates `state.starvationRescuableDeviceIds`
    // while the user is away.
    (document.querySelector('[data-tab="settings"]') as HTMLButtonElement | null)?.click();
    await flushPromises();
    homey.__uiState.starvationRescuableDeviceIds = ['heater-1'];

    // Re-opening Overview must refresh the gate alongside the plan, so the now-
    // rescuable device's chip appears (a fresh plan against a stale gate would
    // miss it).
    (document.querySelector('[data-tab="overview"]') as HTMLButtonElement | null)?.click();
    await waitFor(() => rescueChipButton() !== null);
    expect(rescueChipButton()?.textContent).toBe('Let it run now');
  });

  it('clears a stale chip when the device leaves the rescuable set while off-tab', async () => {
    // Boot rescuable → the chip renders on the boot Overview. Simulation OFF
    // (the rescue chip is suppressed in simulation by design).
    const homey = installHomeyMock({
      settings: buildSettingsHomeyState({ capacity_dry_run: false }),
      uiState: {
        // The Overview's cards are device rows now, so the gate's chip needs
        // the device this plan decides about to be in the device list too.
        devices: budgetHeldPlanDevices,
        plan: budgetHeldPlan,
        starvationRescuableDeviceIds: ['heater-1'],
      },
    });

    await loadSettingsScript();
    await waitFor(() => rescueChipButton() !== null);

    // Off-tab, the device leaves the rescuable set (it recovered / gained a
    // task). Re-opening Overview must refresh the gate so the stale chip clears.
    (document.querySelector('[data-tab="settings"]') as HTMLButtonElement | null)?.click();
    await flushPromises();
    homey.__uiState.starvationRescuableDeviceIds = [];

    (document.querySelector('[data-tab="overview"]') as HTMLButtonElement | null)?.click();
    await waitFor(() => rescueChipButton() === null);
    expect(rescueChipButton()).toBeNull();
  });
});

describe('mode delete confirmation guard', () => {
  const buildModeEditorDom = () => {
    document.body.innerHTML = `
      <md-filled-select id="mode-select"></md-filled-select>
      <md-filled-tonal-button id="add-mode-button"></md-filled-tonal-button>
      <md-text-button id="rename-mode-button"></md-text-button>
      <md-text-button id="delete-mode-button"></md-text-button>
      <div id="mode-name-editor" hidden>
        <md-filled-text-field id="mode-new"></md-filled-text-field>
        <md-text-button id="mode-name-cancel"></md-text-button>
        <md-filled-tonal-button id="mode-name-confirm"></md-filled-tonal-button>
      </div>
      <md-dialog id="mode-delete-dialog"><p id="mode-delete-message"></p></md-dialog>
    `;
  };

  const wireModeEditor = async () => {
    const { initModeEditor } = await import('../src/ui/modeEditor.ts');
    const { state } = await import('../src/ui/state.ts');
    const { deleteModeButton, modeDeleteDialog } = await import('../src/ui/dom.ts');
    if (!modeDeleteDialog) throw new Error('mode delete dialog missing');
    // `.show()` animates via the real md-dialog; a no-op keeps the logic test off
    // jsdom's animation path. The guard sets `returnValue` *before* show(), so
    // stubbing show does not hide the behavior under test.
    modeDeleteDialog.show = () => {};
    state.capacityPriorities = { Home: {} };
    state.editingMode = 'Home';
    const deleteMode = vi.fn().mockResolvedValue(undefined);
    initModeEditor({ addMode: vi.fn(), renameMode: vi.fn(), deleteMode });
    return { deleteMode, deleteButton: deleteModeButton, dialog: modeDeleteDialog };
  };

  beforeEach(() => {
    vi.resetModules();
    buildModeEditorDom();
  });

  it('does not delete until the dialog Delete button confirms, and Cancel/Escape never deletes', async () => {
    const { deleteMode, deleteButton, dialog } = await wireModeEditor();

    // (a) Opening the dialog must not delete on its own.
    deleteButton.click();
    expect(deleteMode).not.toHaveBeenCalled();
    expect(dialog.returnValue).toBe('');

    // (b) Dismissing via Cancel/Escape (any non-'delete' returnValue) never deletes.
    dialog.returnValue = 'cancel';
    dialog.dispatchEvent(new Event('close'));
    expect(deleteMode).not.toHaveBeenCalled();

    // The dialog's Delete button sets returnValue='delete'; only then do we delete.
    deleteButton.click();
    expect(dialog.returnValue).toBe('');
    dialog.returnValue = 'delete';
    dialog.dispatchEvent(new Event('close'));
    expect(deleteMode).toHaveBeenCalledTimes(1);
  });

  it('clears a stale delete result so a later Escape-dismiss cannot delete without confirmation', async () => {
    const { deleteMode, deleteButton, dialog } = await wireModeEditor();

    // First delete is confirmed via the dialog Delete button.
    deleteButton.click();
    dialog.returnValue = 'delete';
    dialog.dispatchEvent(new Event('close'));
    expect(deleteMode).toHaveBeenCalledTimes(1);

    // Re-opening for a second mode must clear the stale 'delete' returnValue…
    deleteButton.click();
    expect(dialog.returnValue).toBe('');

    // …so an Escape/scrim dismiss (which fires `close` without touching the
    // Delete button) does NOT re-fire the stale delete.
    dialog.dispatchEvent(new Event('close'));
    expect(deleteMode).toHaveBeenCalledTimes(1);
  });
});
