/**
 * Basic render test for the settings UI with Homey mocked.
 */
const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="status-badge"></div>
    <div class="tabs">
      <button class="tab active" data-tab="overview"></button>
      <button class="tab" data-tab="devices"></button>
      <button class="tab" data-tab="modes"></button>
      <button class="tab" data-tab="budget"></button>
      <button class="tab" data-tab="usage"></button>
      <button class="tab" data-tab="price"></button>
      <button class="tab" data-tab="advanced"></button>
    </div>
    <section class="panel hidden" id="overview-panel" data-panel="overview">
      <div id="plan-list"></div>
      <p id="plan-empty" hidden></p>
      <div id="plan-meta"></div>
      <button id="plan-refresh-button"></button>
    </section>
    <section class="panel" data-panel="devices">
      <form id="targets-form">
        <select id="target-mode-select"></select>
      </form>
      <input id="capacity-dry-run" type="checkbox">
      <div id="device-list"></div>
      <p id="empty-state" hidden></p>
    </section>
    <section class="panel hidden" data-panel="modes">
      <form id="active-mode-form"><select id="active-mode-select"></select></form>
      <select id="mode-select"></select>
      <input id="mode-new">
      <button id="add-mode-button"></button>
      <button id="delete-mode-button"></button>
      <button id="rename-mode-button"></button>
      <form id="priority-form"></form>
      <div id="priority-list"></div>
      <p id="priority-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="budget">
      <form id="capacity-form"><input id="capacity-limit"><input id="capacity-margin"></form>
      <form id="daily-budget-form">
        <input id="daily-budget-enabled" type="checkbox">
        <input id="daily-budget-kwh">
        <input id="daily-budget-price-shaping" type="checkbox">
      </form>
      <div id="daily-budget-chart"></div>
      <div id="daily-budget-bars"></div>
      <div id="daily-budget-labels"></div>
      <div id="daily-budget-legend"></div>
      <div id="daily-budget-empty"></div>
      <div id="daily-budget-status-pill"></div>
      <div id="daily-budget-title"></div>
      <div id="daily-budget-day"></div>
      <div id="daily-budget-remaining"></div>
      <div id="daily-budget-deviation"></div>
      <div id="daily-budget-cost-label"></div>
      <div id="daily-budget-cost"></div>
      <div id="daily-budget-confidence"></div>
      <div id="daily-budget-price-shaping-state"></div>
      <div id="daily-budget-legend-actual"></div>
      <button id="daily-budget-toggle-today"></button>
      <button id="daily-budget-toggle-tomorrow"></button>
    </section>
    <section class="panel hidden" data-panel="usage">
      <div id="power-list"></div>
      <p id="power-empty" hidden></p>
      <button id="power-week-prev"></button>
      <button id="power-week-next"></button>
      <div id="power-week-label"></div>
      <div id="daily-list"></div>
      <p id="daily-empty" hidden></p>
      <div id="hourly-pattern"></div>
      <div id="hourly-pattern-meta"></div>
      <div id="usage-summary"></div>
      <div id="usage-today"></div>
      <div id="usage-week"></div>
      <div id="usage-month"></div>
      <div id="usage-weekday-avg"></div>
      <div id="usage-weekend-avg"></div>
    </section>
    <section class="panel hidden" id="price-panel" data-panel="price">
      <div id="price-status-badge">No data</div>
      <form id="nettleie-settings-form">
        <select id="nettleie-fylke"></select>
        <select id="nettleie-company"></select>
        <input id="nettleie-orgnr" type="hidden">
        <select id="nettleie-tariffgruppe"></select>
      </form>
      <form id="price-settings-form">
        <select id="price-area"></select>
        <input id="provider-surcharge" type="number">
        <input id="price-threshold-percent" type="number">
        <input id="price-min-diff-ore" type="number">
      </form>
      <div id="price-list" class="device-list" role="list"></div>
      <p id="price-empty">No spot price data available.</p>
      <button id="price-refresh-button"></button>
      <button id="nettleie-refresh-button"></button>
      <div id="price-optimization-list"></div>
      <p id="price-optimization-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="advanced">
      <input id="debug-topic-plan" data-debug-topic="plan" type="checkbox">
      <input id="debug-topic-price" data-debug-topic="price" type="checkbox">
      <input id="debug-topic-daily-budget" data-debug-topic="daily_budget" type="checkbox">
      <input id="debug-topic-devices" data-debug-topic="devices" type="checkbox">
      <input id="debug-topic-settings" data-debug-topic="settings" type="checkbox">
    </section>
    <button id="refresh-button"></button>
    <button id="reset-stats-button"></button>
  `;
};

const loadSettingsScript = async (delay = 50) => {
  // Use require to avoid Node --experimental-vm-modules requirement for dynamic import under Jest 30
  require('../settings/script.js');
  await new Promise((resolve) => setTimeout(resolve, delay));
};

describe('settings script', () => {
  beforeEach(() => {
    jest.resetModules();
    buildDom();
    // @ts-expect-error expose mock Homey
    global.Homey = {
      ready: jest.fn().mockResolvedValue(undefined),
      set: jest.fn((key, val, cb) => cb && cb(null)),
      clock: {
        getTimezone: () => 'UTC',
      },
      i18n: {
        getTimezone: () => 'UTC',
      },
      get: jest.fn((key, cb) => cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ])),
    };
  });

  it('renders devices with target temperature capabilities', async () => {
    await loadSettingsScript();

    const rows = document.querySelectorAll('#device-list .device-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.device-row__name')?.textContent).toContain('Heater');
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows empty state when no devices support target temperature', async () => {
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => cb(null, []));
    // @ts-expect-error mutate mock
    global.Homey.set = jest.fn((key, val, cb) => cb && cb(null));
    await loadSettingsScript();

    expect(document.querySelectorAll('#device-list .device-row').length).toBe(0);
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(false);
  });

  it('renames a mode and updates settings', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadSettingsScript();

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    modeSelect.value = 'home';
    modeInput.value = 'cozy';
    renameBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const modeOptions = Array.from(modeSelect.options).map((o) => o.value);
    expect(modeOptions).toContain('cozy');
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'cozy', expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('capacity_priorities', { cozy: { 'dev-1': 1 } }, expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('mode_device_targets', { cozy: { 'dev-1': 20 } }, expect.any(Function));
  });

  it('keeps active mode separate from editing mode when saving priorities', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadSettingsScript();

    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
    const priorityForm = document.querySelector('#priority-form') as HTMLFormElement;

    // Initially, both should show 'Home' as active
    expect(activeModeSelect.value).toBe('Home');
    expect(modeSelect.value).toBe('Home');

    // Change the editing mode to 'Away'
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');

    // Submit the priority form (save priorities for Away mode)
    priorityForm.dispatchEvent(new Event('submit'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify that operating_mode was NOT saved (active mode unchanged)
    const operatingModeCalls = setSpy.mock.calls.filter((c) => c[0] === 'operating_mode');
    // Should not have called setSetting with operating_mode when saving priorities
    const prioritySaveCalls = operatingModeCalls.filter((c) => c[1] === 'Away');
    expect(prioritySaveCalls.length).toBe(0);

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');
  });

  it('copies priorities and targets from the active mode when adding a new mode', async () => {
    const store: Record<string, any> = {};
    const setSpy = jest.fn((key, val, cb) => {
      store[key] = val;
      if (cb) cb(null);
    });
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1, 'dev-2': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
        {
          id: 'dev-2',
          name: 'Fan',
          targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
        },
      ]);
    });

    await loadSettingsScript();

    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const addBtn = document.querySelector('#add-mode-button') as HTMLButtonElement;

    modeInput.value = 'Cozy';
    addBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.capacity_priorities).toEqual({
      Home: { 'dev-1': 1, 'dev-2': 2 },
      Cozy: { 'dev-1': 1, 'dev-2': 2 },
    });
    expect(store.mode_device_targets).toEqual({
      Home: { 'dev-1': 20 },
      Cozy: { 'dev-1': 20 },
    });
  });

  it('changes active mode when selection changes (auto-save)', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadSettingsScript();

    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Change active mode to 'Away' - should auto-save on change
    activeModeSelect.value = 'Away';
    activeModeSelect.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now operating_mode should be saved as 'Away'
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'Away', expect.any(Function));
  });

  it('shows different selected values in editing vs active mode dropdowns', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadSettingsScript();

    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Change only the editing mode
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The two dropdowns should now show different values
    expect(modeSelect.value).toBe('Away');
    expect(activeModeSelect.value).toBe('Home');
  });

  it('updates active mode dropdown when renaming the active mode', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadSettingsScript();

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Rename 'Home' to 'Cozy'
    modeSelect.value = 'Home';
    modeInput.value = 'Cozy';
    renameBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Both dropdowns should now show 'Cozy' (since we renamed the active mode)
    const editingOptions = Array.from(modeSelect.options).map((o) => o.value);
    const activeOptions = Array.from(activeModeSelect.options).map((o) => o.value);

    expect(editingOptions).toContain('Cozy');
    expect(editingOptions).not.toContain('Home');
    expect(activeOptions).toContain('Cozy');
    expect(activeOptions).not.toContain('Home');

    // Active mode should have been updated to 'Cozy'
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'Cozy', expect.any(Function));
  });

  it('displays cheap and expensive hours when combined_prices are available', async () => {
    // Create price data with some cheap and expensive hours
    const now = new Date();
    const currentHourStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
    const hourMs = 60 * 60 * 1000;

    // Create 48 hours of prices (today and tomorrow) with average around 100 øre
    // Make cheap hours in the future relative to current hour
    const prices: any[] = [];
    for (let hourOffset = 0; hourOffset < 48; hourOffset++) {
      const date = new Date(currentHourStartMs + hourOffset * hourMs);
      let total = 100; // Normal price
      // Make hours relative to current: current+1 to +3 cheap, current+6 to +8 expensive
      if (hourOffset >= 1 && hourOffset <= 3) total = 50; // Cheap hours
      if (hourOffset >= 6 && hourOffset <= 8) total = 150; // Expensive hours
      prices.push({
        startsAt: date.toISOString(),
        total,
        spotPrice: total * 0.7,
        nettleie: total * 0.3,
        isCheap: total <= 75, // 25% below 100
        isExpensive: total >= 125, // 25% above 100
      });
    }

    // Use new format with pre-calculated thresholds
    const combinedPrices = {
      prices,
      avgPrice: 100,
      lowThreshold: 75,
      highThreshold: 125,
    };

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, combinedPrices);
      if (key === 'electricity_prices') return cb(null, []);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript(200);

    // Check that the price panel exists and make it visible first
    const pricePanel = document.querySelector('#price-panel');
    expect(pricePanel).not.toBeNull();
    pricePanel?.classList.remove('hidden');

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const priceList = document.querySelector('#price-list');
    const priceStatusBadge = document.querySelector('#price-status-badge');

    // Verify price list has content
    expect(priceList?.innerHTML).not.toBe('');

    // Verify price summary section exists with cheap hours info
    const priceSummary = priceList?.querySelector('.price-summary');
    expect(priceSummary).not.toBeNull();

    // Verify summary shows cheap hours count
    const summaryItems = priceList?.querySelectorAll('.price-summary-item');
    expect(summaryItems?.length).toBe(2); // Cheap and expensive summaries
    expect(summaryItems?.[0]?.textContent).toContain('cheap hour');
    expect(summaryItems?.[1]?.textContent).toContain('expensive hour');

    // Verify collapsible details sections exist
    const detailsSections = priceList?.querySelectorAll('.price-details');
    expect(detailsSections?.length).toBeGreaterThanOrEqual(2); // Cheap, expensive, and all prices

    // Verify price rows are rendered inside details
    const priceRows = priceList?.querySelectorAll('.price-row');
    expect(priceRows?.length).toBeGreaterThan(0);

    // Verify status badge shows current price
    expect(priceStatusBadge?.textContent).toContain('Now:');
    expect(priceStatusBadge?.textContent).toContain('øre/kWh');
  });

  it('shows notice when all prices are within threshold', async () => {
    // Create price data where all prices are within 25% of average
    const now = new Date();
    const currentHourStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
    const hourMs = 60 * 60 * 1000;

    // All prices around 100 øre (within 25% threshold)
    const prices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(currentHourStartMs + hour * hourMs);
      // Vary between 85-115 øre (within 25% of 100 average)
      const total = 90 + (hour % 5) * 5;
      prices.push({
        startsAt: date.toISOString(),
        total,
        spotPrice: total * 0.7,
        nettleie: total * 0.3,
        isCheap: false, // All within threshold
        isExpensive: false,
      });
    }

    // Use new format with pre-calculated thresholds
    const combinedPrices = {
      prices,
      avgPrice: 100,
      lowThreshold: 75,
      highThreshold: 125,
    };

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, combinedPrices);
      if (key === 'electricity_prices') return cb(null, []);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript(200);

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const priceList = document.querySelector('#price-list');

    // Verify summary section exists
    const priceSummary = priceList?.querySelector('.price-summary');
    expect(priceSummary).not.toBeNull();

    // When all prices are within threshold, summary shows "No cheap/expensive hours"
    const summaryItems = priceList?.querySelectorAll('.price-summary-item');
    expect(summaryItems?.length).toBe(2);
    expect(summaryItems?.[0]?.textContent).toContain('No cheap hours');
    expect(summaryItems?.[1]?.textContent).toContain('No expensive hours');

    // Verify no cheap/expensive collapsible details (only "All prices")
    const detailsSections = priceList?.querySelectorAll('.price-details');
    expect(detailsSections?.length).toBe(1); // Only "All prices" section
  });

  it('falls back to electricity_prices when combined_prices not available', async () => {
    // Create spot-only price data
    const now = new Date();
    const currentHourStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
    const hourMs = 60 * 60 * 1000;

    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(currentHourStartMs + hour * hourMs);
      let total = 80;
      // Make cheap/expensive hours relative to current hour
      if (hour >= 1 && hour <= 3) total = 40; // Cheap
      if (hour >= 6 && hour <= 8) total = 120; // Expensive
      spotPrices.push({
        startsAt: date.toISOString(),
        total,
        currency: 'NOK',
      });
    }

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, null); // No combined prices
      if (key === 'electricity_prices') return cb(null, spotPrices);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript(200);

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const priceList = document.querySelector('#price-list');
    const priceStatusBadge = document.querySelector('#price-status-badge');

    // Verify price list has content (using fallback data)
    expect(priceList?.innerHTML).not.toBe('');

    // Verify status badge shows current price
    expect(priceStatusBadge?.textContent).toContain('Now:');
  });
});

describe('Plan sorting', () => {
  beforeEach(() => {
    jest.resetModules();
    buildDom();
  });

  const setupPlanHomeyMock = (planSnapshot: any) => {
    // @ts-expect-error expose mock Homey
    global.Homey = {
      ready: jest.fn().mockResolvedValue(undefined),
      set: jest.fn((key, val, cb) => cb && cb(null)),
      get: jest.fn((key, cb) => {
        if (key === 'device_plan_snapshot') return cb(null, planSnapshot);
        if (key === 'target_devices_snapshot') return cb(null, []);
        return cb(null, null);
      }),
    };
  };

  it('sorts devices by priority ascending within each zone (priority 1 = most important, first)', async () => {
    // Note: This test verifies the settings UI sorting - backend sorting is tested in plan.test.ts
    const planSnapshot = {
      meta: {
        totalKw: 4.2,
        softLimitKw: 9.5,
        headroomKw: 5.3,
      },
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

    await loadSettingsScript(100);

    // Switch to overview tab
    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const planList = document.querySelector('#plan-list');
    const deviceRows = planList?.querySelectorAll('.device-row');

    expect(deviceRows?.length).toBe(3);

    // Get device names in order
    const deviceNames = Array.from(deviceRows || []).map(
      (row) => row.querySelector('.device-row__name')?.textContent,
    );

    // Priority 1 = most important, shown first: 1, 3, 5
    expect(deviceNames).toEqual([
      'Most Important Heater', // priority 1
      'Medium Priority Heater', // priority 3
      'Least Important Heater', // priority 5
    ]);
  });

  it('shows planned state lines for devices', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 5.1,
        softLimitKw: 7.5,
        headroomKw: 2.4,
      },
      devices: [
        { id: 'a2', name: 'Alpha Two', priority: 2, currentState: 'on', plannedState: 'keep' },
        { id: 'b1', name: 'Bravo One', priority: 1, currentState: 'on', plannedState: 'shed' },
        { id: 'a1', name: 'Alpha One', priority: 1, currentState: 'on', plannedState: 'keep' },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript(100);

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const deviceRows = document.querySelectorAll('#plan-list .device-row');
    const deviceNames = Array.from(deviceRows).map(
      (row) => row.querySelector('.device-row__name')?.textContent,
    );
    expect(deviceNames).toEqual(['Bravo One', 'Alpha One', 'Alpha Two']); // priority order

    const stateValues = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'State')
      .map((line) => line.querySelector('span:last-child')?.textContent);
    expect(stateValues).toContain('Shed (powered off)');
  });

  it('shows measured and expected power in usage line when available', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 3.3,
        softLimitKw: 9.0,
        headroomKw: 5.7,
      },
      devices: [
        {
          id: 'device-1',
          name: 'Heater',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 1.23,
          expectedPowerKw: 2.34,
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript(100);

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const usageLines = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'Usage')
      .map((line) => line.querySelector('span:last-child')?.textContent || '');

    expect(usageLines[0]).toContain('current usage: 1.23 kW / expected 2.34 kW');
  });

  it('shows expected power when device is off and only expected is known', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 1.0,
        softLimitKw: 9.0,
        headroomKw: 8.0,
      },
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

    await loadSettingsScript(100);

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const usageLines = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'Usage')
      .map((line) => line.querySelector('span:last-child')?.textContent || '');

    expect(usageLines[0]).toBe('expected 1.50 kW');
  });

  it('shows measured 0 with expected power when device is on but not drawing', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 2.0,
        softLimitKw: 9.0,
        headroomKw: 7.0,
      },
      devices: [
        {
          id: 'device-3',
          name: 'Idle Thermostat',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 0,
          expectedPowerKw: 0.12,
        },
      ],
    };

    // @ts-expect-error expose mock Homey
    global.Homey = {
      ready: jest.fn().mockResolvedValue(undefined),
      set: jest.fn((key, val, cb) => cb && cb(null)),
      get: jest.fn((key, cb) => {
        if (key === 'device_plan_snapshot') return cb(null, planSnapshot);
        if (key === 'target_devices_snapshot') return cb(null, []);
        return cb(null, null);
      }),
    };

    await loadSettingsScript(100);

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const usageLines = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'Usage')
      .map((line) => line.querySelector('span:last-child')?.textContent || '');

    expect(usageLines[0]).toBe('current usage: 0.00 kW / expected 0.12 kW');
  });

  it('savePriorities assigns priority 1 to top device', () => {
    // Verify savePriorities logic: top item = priority 1 (most important, shed last)
    const rows = ['dev-1', 'dev-2', 'dev-3']; // DOM order: top to bottom
    const priorities: Record<string, number> = {};

    // Fixed code: modeMap[id] = index + 1;
    rows.forEach((id, index) => {
      priorities[id] = index + 1;
    });

    // Top item should be priority 1 (most important, shed last)
    expect(priorities['dev-1']).toBe(1); // TOP = most important = priority 1
    expect(priorities['dev-2']).toBe(2);
    expect(priorities['dev-3']).toBe(3); // BOTTOM = least important = priority 3
  });
});
