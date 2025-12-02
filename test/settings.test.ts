/**
 * Basic render test for the settings UI with Homey mocked.
 */
const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="status-badge"></div>
    <div class="tabs">
      <button class="tab active" data-tab="devices"></button>
      <button class="tab" data-tab="power"></button>
      <button class="tab" data-tab="plan"></button>
      <button class="tab" data-tab="price"></button>
    </div>
    <section class="panel" data-panel="devices">
      <form id="targets-form">
        <select id="target-mode-select"></select>
      </form>
      <div id="device-list"></div>
      <p id="empty-state" hidden></p>
    </section>
    <section class="panel hidden" data-panel="power">
      <form id="capacity-form"><input id="capacity-limit"><input id="capacity-margin"><input id="capacity-dry-run" type="checkbox"></form>
      <form id="active-mode-form"><select id="active-mode-select"></select></form>
      <select id="mode-select"></select>
      <input id="mode-new">
      <button id="add-mode-button"></button>
      <button id="delete-mode-button"></button>
      <button id="rename-mode-button"></button>
      <form id="priority-form"></form>
      <div id="priority-list"></div>
      <p id="priority-empty" hidden></p>
      <div id="power-list"></div>
      <p id="power-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="plan">
      <div id="plan-list"></div>
      <p id="plan-empty" hidden></p>
      <div id="plan-meta"></div>
      <button id="plan-refresh-button"></button>
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
      </form>
      <div id="price-list" class="device-list" role="list"></div>
      <p id="price-empty">No spot price data available.</p>
      <button id="price-refresh-button"></button>
      <button id="nettleie-refresh-button"></button>
      <div id="price-optimization-list"></div>
      <p id="price-optimization-empty" hidden></p>
    </section>
    <button id="refresh-button"></button>
    <button id="reset-stats-button"></button>
  `;
};

describe('settings script', () => {
  beforeEach(() => {
    jest.resetModules();
    buildDom();
    // @ts-expect-error expose mock Homey
    global.Homey = {
      ready: jest.fn().mockResolvedValue(undefined),
      set: jest.fn((key, val, cb) => cb && cb(null)),
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
    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = document.querySelectorAll('#device-list .device-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.device-row__name')?.textContent).toContain('Heater');
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#status-badge')?.textContent).toBe('Live');
  });

  it('shows empty state when no devices support target temperature', async () => {
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => cb(null, []));
    // @ts-expect-error mutate mock
    global.Homey.set = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

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
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    modeSelect.value = 'home';
    modeInput.value = 'cozy';
    renameBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const modeOptions = Array.from(modeSelect.options).map((o) => o.value);
    expect(modeOptions).toContain('cozy');
    expect(setSpy).toHaveBeenCalledWith('capacity_mode', 'cozy', expect.any(Function));
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
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

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

    // Verify that capacity_mode was NOT saved (active mode unchanged)
    const capacityModeCalls = setSpy.mock.calls.filter((c) => c[0] === 'capacity_mode');
    // Should not have called setSetting with capacity_mode when saving priorities
    const prioritySaveCalls = capacityModeCalls.filter((c) => c[1] === 'Away');
    expect(prioritySaveCalls.length).toBe(0);

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');
  });

  it('changes active mode only when explicitly set via active mode form', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
    const activeModeForm = document.querySelector('#active-mode-form') as HTMLFormElement;

    // Change active mode to 'Away' via the form
    activeModeSelect.value = 'Away';
    activeModeForm.dispatchEvent(new Event('submit'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now capacity_mode should be saved as 'Away'
    expect(setSpy).toHaveBeenCalledWith('capacity_mode', 'Away', expect.any(Function));
  });

  it('shows different selected values in editing vs active mode dropdowns', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

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
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    expect(setSpy).toHaveBeenCalledWith('capacity_mode', 'Cozy', expect.any(Function));
  });

  it('displays cheap and expensive hours when combined_prices are available', async () => {
    // Create price data with some cheap and expensive hours
    const now = new Date();
    const currentHour = now.getHours();
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Create 24 hours of prices with average around 100 øre
    // Make cheap hours in the future relative to current hour
    const prices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      let total = 100; // Normal price
      // Make hours relative to current: current+1 to +3 cheap, current+6 to +8 expensive
      const hoursFromNow = hour - currentHour;
      if (hoursFromNow >= 1 && hoursFromNow <= 3) total = 50; // Cheap hours
      if (hoursFromNow >= 6 && hoursFromNow <= 8) total = 150; // Expensive hours
      prices.push({
        startsAt: date.toISOString(),
        total,
        spotPrice: total * 0.7,
        nettleie: total * 0.3,
        isCheap: total <= 75,  // 25% below 100
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

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 200));

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
    
    // Verify cheap hours section is shown
    const cheapHeader = priceList?.querySelector('.price-section-header.cheap');
    expect(cheapHeader).not.toBeNull();
    expect(cheapHeader?.textContent).toContain('Cheap hours');
    
    // Verify expensive hours section is shown  
    const expensiveHeader = priceList?.querySelector('.price-section-header.expensive');
    expect(expensiveHeader).not.toBeNull();
    expect(expensiveHeader?.textContent).toContain('Expensive hours');
    
    // Verify price rows are rendered
    const priceRows = priceList?.querySelectorAll('.price-row');
    expect(priceRows?.length).toBeGreaterThan(0);
    
    // Verify status badge shows current price
    expect(priceStatusBadge?.textContent).toContain('Now:');
    expect(priceStatusBadge?.textContent).toContain('øre/kWh');
  });

  it('shows notice when all prices are within threshold', async () => {
    // Create price data where all prices are within 25% of average
    const now = new Date();
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // All prices around 100 øre (within 25% threshold)
    const prices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      // Vary between 85-115 øre (within 25% of 100 average)
      const total = 90 + (hour % 5) * 5;
      prices.push({
        startsAt: date.toISOString(),
        total,
        spotPrice: total * 0.7,
        nettleie: total * 0.3,
        isCheap: false,  // All within threshold
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

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const priceList = document.querySelector('#price-list');
    
    // Verify notice is shown instead of cheap/expensive sections
    const notice = priceList?.querySelector('.price-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('within 25% of average');
    
    // Verify no cheap/expensive headers
    const cheapHeader = priceList?.querySelector('.price-section-header.cheap');
    const expensiveHeader = priceList?.querySelector('.price-section-header.expensive');
    expect(cheapHeader).toBeNull();
    expect(expensiveHeader).toBeNull();
  });

  it('falls back to electricity_prices when combined_prices not available', async () => {
    // Create spot-only price data
    const now = new Date();
    const currentHour = now.getHours();
    const baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(baseDate);
      date.setHours(hour, 0, 0, 0);
      let total = 80;
      // Make cheap/expensive hours relative to current hour
      const hoursFromNow = hour - currentHour;
      if (hoursFromNow >= 1 && hoursFromNow <= 3) total = 40; // Cheap
      if (hoursFromNow >= 6 && hoursFromNow <= 8) total = 120; // Expensive
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

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 200));

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
