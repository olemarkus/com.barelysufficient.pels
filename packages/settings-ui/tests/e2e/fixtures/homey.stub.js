(() => {
  const listeners = Object.create(null);
  const initialOverrides = (
    window.__PELS_HOMEY_STUB__ && typeof window.__PELS_HOMEY_STUB__ === 'object'
  )
    ? window.__PELS_HOMEY_STUB__
    : {};
  const hasInitialDailyBudgetPayload = Object.prototype.hasOwnProperty.call(initialOverrides, 'dailyBudgetPayload');

  // Default to redesign in the local preview unless the test stub explicitly disables it.
  if (initialOverrides.overviewRedesignEnabled !== false) {
    try { localStorage.setItem('pels.settingsUi.overviewRedesignEnabled', 'true'); } catch (e) { void e; }
  }

  const runtimeOverrides = {
    apiHandlers: Object.create(null),
    apiCallCounts: Object.create(null),
    dailyBudgetPayload: hasInitialDailyBudgetPayload ? initialOverrides.dailyBudgetPayload : undefined,
  };
  if (initialOverrides.apiHandlers && typeof initialOverrides.apiHandlers === 'object') {
    Object.assign(runtimeOverrides.apiHandlers, initialOverrides.apiHandlers);
  }

  const emit = (event, ...args) => {
    const cbs = listeners[event];
    if (!Array.isArray(cbs)) return;
    cbs.forEach((cb) => {
      try {
        cb(...args);
      } catch (err) {
        console.error('Homey stub listener error', event, err);
      }
    });
  };

  const startOfUtcHourMs = (date) => {
    const d = new Date(date.getTime());
    d.setUTCMinutes(0, 0, 0);
    return d.getTime();
  };

  const dateKeyUtc = (ms) => {
    const d = new Date(ms);
    const y = String(d.getUTCFullYear()).padStart(4, '0');
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const buildSampleCombinedPrices = () => {
    const now = new Date();
    const startMs = startOfUtcHourMs(now);
    const prices = [];

    // Semi-realistic shape in ore/kWh.
    for (let i = 0; i < 48; i += 1) {
      const t = startMs + i * 3600 * 1000;
      const dayPhase = (i % 24) / 24;
      const base = 55;
      const swing = 22 * Math.sin(dayPhase * Math.PI * 2 - Math.PI / 2);
      const noise = (i % 7) * 0.7 - 2;
      const total = Math.max(10, base + swing + noise);
      const vatMultiplier = 1.25;
      const spotPriceExVat = total / vatMultiplier;

      prices.push({
        startsAt: new Date(t).toISOString(),
        total,
        spotPriceExVat,
        vatMultiplier,
        vatAmount: total - spotPriceExVat,
        totalExVat: spotPriceExVat,
      });
    }

    const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / Math.max(1, prices.length);
    const lowThreshold = avgPrice * 0.75;
    const highThreshold = avgPrice * 1.25;

    prices.forEach((p) => {
      p.isCheap = p.total <= lowThreshold;
      p.isExpensive = p.total >= highThreshold;
    });

    return {
      prices,
      avgPrice,
      lowThreshold,
      highThreshold,
      lastFetched: new Date().toISOString(),
      priceScheme: 'norway',
      priceUnit: 'øre/kWh',
    };
  };

  const buildSamplePowerTracker = () => {
    const now = new Date();
    const endMs = startOfUtcHourMs(now) + 3600 * 1000;
    const startMs = endMs - 14 * 24 * 3600 * 1000;

    const buckets = Object.create(null);
    const controlledBuckets = Object.create(null);
    const uncontrolledBuckets = Object.create(null);

    for (let t = startMs; t < endMs; t += 3600 * 1000) {
      const d = new Date(t);
      const hour = d.getUTCHours();
      const weekday = d.getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;

      const base = isWeekend ? 0.55 : 0.45;
      const morningPeak = hour >= 6 && hour <= 9 ? 0.35 : 0;
      const eveningPeak = hour >= 17 && hour <= 21 ? 0.45 : 0;
      const nightDip = hour >= 0 && hour <= 4 ? -0.18 : 0;

      const kWh = Math.max(0.05, base + morningPeak + eveningPeak + nightDip);
      const iso = d.toISOString();

      buckets[iso] = Number(kWh.toFixed(3));
      controlledBuckets[iso] = Number((kWh * 0.42).toFixed(3));
      uncontrolledBuckets[iso] = Number((kWh * 0.58).toFixed(3));
    }

    // Mark a short unreliable window yesterday evening.
    const unreliableStart = startOfUtcHourMs(new Date(Date.now() - 28 * 3600 * 1000));
    const unreliableEnd = unreliableStart + 2 * 3600 * 1000;

    return {
      buckets,
      controlledBuckets,
      uncontrolledBuckets,
      unreliablePeriods: [{ start: unreliableStart, end: unreliableEnd }],
    };
  };

  const buildSamplePlanSnapshot = () => {
    return {
      meta: {
        totalKw: 1.5,
        softLimitKw: 2.3,
        capacitySoftLimitKw: 2.3,
        hardLimitKw: 8.0,
        dailySoftLimitKw: null,
        softLimitSource: 'capacity',
        headroomKw: 0.8,
        usedKWh: 0.26,
        budgetKWh: 4.5,
        minutesRemaining: 48,
        controlledKw: 0.0,
        uncontrolledKw: 1.5,
        hourControlledKWh: 0.0,
        hourUncontrolledKWh: 0.11,
        hardCapHeadroomKw: 6.5,
      },
      devices: [
        {
          id: 'dev_heatpump',
          name: 'Living Room Heat Pump',
          currentState: 'on',
          plannedState: 'keep',
          controlModel: 'temperature_target',
          deviceClass: 'thermostat',
          currentTarget: 22,
          plannedTarget: 22,
          currentTemperature: 20.3,
          priority: 1,
          controllable: true,
          expectedPowerKw: 1.6,
          measuredPowerKw: 1.2,
          reason: { code: 'keep', detail: null },
          shedAction: 'set_temperature',
          shedTemperature: 16,
        },
        {
          id: 'dev_waterheater',
          name: 'Water Heater',
          currentState: 'on',
          plannedState: 'shed',
          priority: 2,
          controllable: true,
          expectedPowerKw: 2.0,
          measuredPowerKw: 2.1,
          reason: { code: 'capacity', detail: 'high household load' },
          shedAction: 'turn_off',
        },
        {
          id: 'dev_bedroom',
          name: 'Bedroom Thermostat',
          currentState: 'on',
          plannedState: 'keep',
          controlModel: 'temperature_target',
          deviceClass: 'thermostat',
          currentTarget: 22,
          plannedTarget: 22,
          currentTemperature: 22.8,
          priority: 3,
          controllable: true,
          expectedPowerKw: 0.5,
          measuredPowerKw: 0,
          reason: { code: 'keep', detail: null },
          shedAction: 'set_temperature',
          shedTemperature: 15,
        },
        {
          id: 'dev_hallway',
          name: 'Hallway Thermostat',
          currentState: 'off',
          plannedState: 'keep',
          controlModel: 'temperature_target',
          deviceClass: 'thermostat',
          currentTarget: 20,
          plannedTarget: 20,
          currentTemperature: 19.1,
          priority: 3,
          controllable: true,
          expectedPowerKw: 0.8,
          measuredPowerKw: 0,
          reason: {
            code: 'insufficient_headroom',
            needKw: 0.8,
            availableKw: 0.2,
            postReserveMarginKw: null,
            minimumRequiredPostReserveMarginKw: null,
            penaltyExtraKw: null,
            swapReserveKw: null,
            effectiveAvailableKw: null,
            swapTargetName: null,
          },
          shedAction: 'set_temperature',
          shedTemperature: 15,
        },
        {
          id: 'dev_zaptec',
          name: 'Zaptec Go',
          currentState: 'not_applicable',
          plannedState: 'keep',
          controlModel: 'stepped_load',
          controlCapabilityId: 'evcharger_charging',
          evChargingState: 'plugged_in_charging',
          priority: 4,
          controllable: true,
          expectedPowerKw: 1.38,
          measuredPowerKw: 1.38,
          planningPowerKw: 1.38,
          actualStepId: '6a',
          reportedStepId: '6a',
          targetStepId: '6a',
          desiredStepId: '6a',
          actualStepSource: 'reported',
          binaryCommandPending: false,
          reason: { code: 'headroom_cooldown', remainingSec: 45, countdownStartedAtMs: Date.now() - 15000 },
          shedAction: 'set_step',
        },
        {
          id: 'dev_connected300',
          name: 'Connected 300',
          currentState: 'off',
          plannedState: 'keep',
          controlModel: 'stepped_load',
          priority: 5,
          controllable: true,
          expectedPowerKw: 0.0,
          measuredPowerKw: 0.0,
          planningPowerKw: 0.0,
          currentTemperature: 51.1,
          plannedTarget: 65,
          actualStepId: 'low',
          reportedStepId: 'low',
          targetStepId: 'low',
          desiredStepId: 'high',
          actualStepSource: 'reported',
          reason: {
            code: 'insufficient_headroom',
            needKw: 1.5,
            availableKw: 1.3,
            postReserveMarginKw: null,
            minimumRequiredPostReserveMarginKw: null,
            penaltyExtraKw: null,
            swapReserveKw: null,
            effectiveAvailableKw: null,
            swapTargetName: null,
          },
          shedAction: 'set_step',
        },
        {
          id: 'dev_evcharger',
          name: 'Generic EV Charger',
          currentState: 'off',
          plannedState: 'keep',
          priority: 6,
          controllable: true,
          expectedPowerKw: 7.2,
          measuredPowerKw: 0,
          reason: {
            code: 'insufficient_headroom',
            needKw: 7.2,
            availableKw: 1.4,
            postReserveMarginKw: null,
            minimumRequiredPostReserveMarginKw: null,
            penaltyExtraKw: null,
            swapReserveKw: null,
            effectiveAvailableKw: null,
            swapTargetName: null,
          },
          shedAction: 'turn_off',
        },
      ],
    };
  };

  const buildSampleDailyBudgetPayload = () => {
    const now = new Date();
    const nowMs = now.getTime();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).getTime();
    const dailyBudgetKWh = Number(settings.daily_budget_kwh ?? 0);
    const dailyBudgetEnabled = settings.daily_budget_enabled !== false;
    const dailyBudgetPriceShapingEnabled = settings.daily_budget_price_shaping_enabled !== false;

    const makeDay = (dayStartMs) => {
      const startUtc = [];
      const startLocalLabels = [];
      const plannedWeight = [];
      const plannedKWh = [];
      const actualKWh = [];
      const allowedCumKWh = [];
      const price = [];

      let cum = 0;

      for (let i = 0; i < 24; i += 1) {
        const t = dayStartMs + i * 3600 * 1000;
        startUtc.push(new Date(t).toISOString());
        startLocalLabels.push(String(i).padStart(2, '0'));

        // Typical usage curve.
        const w = i >= 6 && i <= 9 ? 1.4 : (i >= 17 && i <= 21 ? 1.6 : 0.8);
        plannedWeight.push(w);

        const kwh = 0.35 * w;
        plannedKWh.push(Number(kwh.toFixed(3)));

        // Actual tracks planned, but with some bias.
        const actual = Math.max(0, kwh + (i % 5 === 0 ? 0.08 : -0.02));
        actualKWh.push(Number(actual.toFixed(3)));

        cum += kwh;
        allowedCumKWh.push(Number(cum.toFixed(3)));

        // Rough Norway price shape in raw "øre/kWh" units for the budget view.
        const p = 80 + 35 * Math.sin((i / 24) * Math.PI * 2 - Math.PI / 2);
        price.push(Number(p.toFixed(1)));
      }

      const dateKey = dateKeyUtc(dayStartMs);
      const currentBucketIndex = Math.max(0, Math.min(23, Math.floor((nowMs - dayStartMs) / (3600 * 1000))));
      const usedNowKWh = actualKWh.slice(0, currentBucketIndex + 1).reduce((sum, v) => sum + v, 0);
      const allowedNowKWh = allowedCumKWh[currentBucketIndex] ?? 0;
      const remainingKWh = dailyBudgetKWh - usedNowKWh;
      const deviationKWh = usedNowKWh - allowedNowKWh;

      return {
        dateKey,
        timeZone: 'UTC',
        nowUtc: new Date(nowMs).toISOString(),
        dayStartUtc: new Date(dayStartMs).toISOString(),
        currentBucketIndex,
        budget: {
          enabled: dailyBudgetEnabled,
          dailyBudgetKWh,
          priceShapingEnabled: dailyBudgetPriceShapingEnabled,
        },
        state: {
          usedNowKWh: Number(usedNowKWh.toFixed(3)),
          allowedNowKWh: Number(allowedNowKWh.toFixed(3)),
          remainingKWh: Number(remainingKWh.toFixed(3)),
          deviationKWh: Number(deviationKWh.toFixed(3)),
          exceeded: remainingKWh < 0,
          frozen: false,
          confidence: 0.72,
          priceShapingActive: true,
        },
        buckets: {
          startUtc,
          startLocalLabels,
          plannedWeight,
          plannedKWh,
          actualKWh,
          allowedCumKWh,
          price,
        },
      };
    };

    const today = makeDay(todayStart);
    const tomorrow = makeDay(todayStart + 24 * 3600 * 1000);
    const yesterday = makeDay(todayStart - 24 * 3600 * 1000);

    return {
      days: {
        [yesterday.dateKey]: yesterday,
        [today.dateKey]: today,
        [tomorrow.dateKey]: tomorrow,
      },
      todayKey: today.dateKey,
      tomorrowKey: tomorrow.dateKey,
      yesterdayKey: yesterday.dateKey,
    };
  };

  const combinedPrices = buildSampleCombinedPrices();
  const evDeviceSnapshot = {
    id: 'dev_evcharger',
    name: 'Generic EV Charger',
    deviceClass: 'evcharger',
    deviceType: 'onoff',
    currentOn: false,
    controlCapabilityId: 'evcharger_charging',
    evChargingState: 'plugged_in_paused',
    measuredPowerKw: 0,
    expectedPowerKw: 7.2,
    capabilities: ['evcharger_charging', 'evcharger_charging_state'],
  };
  const evPlanDevice = {
    id: 'dev_evcharger',
    name: 'Generic EV Charger',
    currentState: 'off',
    plannedState: 'keep',
    priority: 3,
    controllable: true,
    expectedPowerKw: 7.2,
    measuredPowerKw: 0,
    reason: 'Waiting for headroom',
    shedAction: 'turn_off',
  };

  const settings = {
    // Devices
    target_devices_snapshot: [
      {
        id: 'dev_heatpump',
        name: 'Living Room Heat Pump',
        deviceClass: 'heater',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 1.2,
        expectedPowerKw: 1.6,
        targets: [{ name: 'target_temperature', value: 22 }],
      },
      {
        id: 'dev_floorheat',
        name: 'Bathroom Floor Heat',
        deviceClass: 'heater',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 0.4,
        expectedPowerKw: 0.6,
        targets: [{ name: 'target_temperature', value: 24 }],
      },
      {
        id: 'dev_waterheater',
        name: 'Water Heater',
        deviceClass: 'waterheater',
        measuredPowerKw: 2.1,
        expectedPowerKw: 2.0,
      },
      {
        id: 'dev_bedroom',
        name: 'Bedroom Thermostat',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 0,
        expectedPowerKw: 0.5,
        currentTemperature: 20.8,
        targets: [{ name: 'target_temperature', value: 16 }],
      },
      {
        id: 'dev_hallway',
        name: 'Hallway Thermostat',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 0,
        expectedPowerKw: 0.8,
        currentTemperature: 19.1,
        targets: [{ name: 'target_temperature', value: 20 }],
      },
      {
        id: 'dev_zaptec',
        name: 'Zaptec Go',
        deviceClass: 'evcharger',
        deviceType: 'onoff',
        controlModel: 'stepped_load',
        controlCapabilityId: 'evcharger_charging',
        evChargingState: 'plugged_in_charging',
        currentOn: true,
        measuredPowerKw: 1.38,
        expectedPowerKw: 1.38,
        capabilities: ['evcharger_charging', 'evcharger_charging_state'],
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: '6a', planningPowerW: 1380 },
            { id: '8a', planningPowerW: 1840 },
            { id: '10a', planningPowerW: 2300 },
            { id: '12a', planningPowerW: 2760 },
            { id: '16a', planningPowerW: 3680 },
            { id: '20a', planningPowerW: 4600 },
          ],
        },
        actualStepId: '6a',
        reportedStepId: '6a',
        targetStepId: '6a',
        actualStepSource: 'reported',
      },
      {
        id: 'dev_connected300',
        name: 'Connected 300',
        deviceClass: 'waterheater',
        deviceType: 'onoff',
        controlModel: 'stepped_load',
        currentOn: true,
        currentTemperature: 51.1,
        plannedTarget: 65,
        measuredPowerKw: 0.0,
        expectedPowerKw: 0.0,
        capabilities: ['onoff'],
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'low', planningPowerW: 750 },
            { id: 'medium', planningPowerW: 1500 },
            { id: 'high', planningPowerW: 2000 },
          ],
        },
        actualStepId: 'low',
        reportedStepId: 'low',
        targetStepId: 'low',
        actualStepSource: 'reported',
      },
    ],

    // Mode / priority
    operating_mode: 'Home',
    mode_aliases: { home: 'Home', away: 'Away' },
    managed_devices: {
      dev_heatpump: true,
      dev_floorheat: true,
      dev_waterheater: true,
      dev_evcharger: false,
      dev_bedroom: true,
      dev_hallway: true,
      dev_zaptec: true,
      dev_connected300: true,
    },
    budget_exempt_devices: {
      dev_waterheater: true,
    },
    controllable_devices: {
      dev_heatpump: true,
      dev_floorheat: false,
      dev_waterheater: true,
      dev_evcharger: true,
      dev_bedroom: true,
      dev_hallway: true,
      dev_zaptec: true,
      dev_connected300: true,
    },
    capacity_priorities: {
      Home: {
        dev_heatpump: 1,
        dev_waterheater: 2,
        dev_bedroom: 3,
        dev_hallway: 3,
        dev_zaptec: 4,
        dev_connected300: 5,
        dev_evcharger: 6,
        dev_floorheat: 7,
      },
    },
    mode_device_targets: {
      Home: {
        dev_heatpump: 21,
        dev_floorheat: 24,
        dev_bedroom: 20,
      },
      Away: {
        dev_heatpump: 18,
        dev_floorheat: 19,
        dev_bedroom: 17,
      },
    },

    // Shedding behavior
    overshoot_behaviors: {
      dev_heatpump: { action: 'set_temperature', temperature: 16 },
      dev_waterheater: { action: 'turn_off' },
    },

    // Capacity settings
    capacity_limit_kw: 8,
    capacity_margin_kw: 0.4,
    capacity_dry_run: true,
    experimental_ev_support_enabled: false,
    overview_redesign_enabled: false,

    // Status and heartbeat
    pels_status: { lastPowerUpdate: Date.now() - 12 * 1000 },
    app_heartbeat: Date.now() - 5 * 1000,

    // Prices
    price_scheme: 'norway',
    norway_price_model: 'stromstotte',
    price_area: 'NO1',
    provider_surcharge: 0,
    price_threshold_percent: 25,
    price_min_diff_ore: 0,
    refresh_spot_prices: null,
    combined_prices: combinedPrices,

    // Price optimization
    price_optimization_enabled: true,
    price_optimization_settings: {
      dev_heatpump: { enabled: true, cheapDelta: 4, expensiveDelta: -4 },
      dev_floorheat: { enabled: true, cheapDelta: 2, expensiveDelta: -2 },
    },

    // Power tracking
    power_tracker_state: buildSamplePowerTracker(),

    // Daily budget settings
    daily_budget_enabled: true,
    daily_budget_kwh: 12,
    daily_budget_price_shaping_enabled: true,
    daily_budget_controlled_weight: 1,
    daily_budget_price_flex_share: 0.3,
    daily_budget_breakdown_enabled: false,

    // In-memory plan snapshot
    plan_snapshot: buildSamplePlanSnapshot(),

    // Grid tariff settings
    nettleie_fylke: '03',
    nettleie_orgnr: '',
    nettleie_tariffgruppe: 'Husholdning',

    // Device control profiles (stepped load)
    device_control_profiles: {
      dev_zaptec: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: '6a', planningPowerW: 1380 },
          { id: '8a', planningPowerW: 1840 },
          { id: '10a', planningPowerW: 2300 },
          { id: '12a', planningPowerW: 2760 },
          { id: '16a', planningPowerW: 3680 },
          { id: '20a', planningPowerW: 4600 },
        ],
      },
      dev_connected300: {
        model: 'stepped_load',
        steps: [
          { id: 'low', planningPowerW: 750 },
          { id: 'medium', planningPowerW: 1500 },
          { id: 'high', planningPowerW: 2000 },
        ],
      },
    },

    // Debug
    debug_logging_topics: [],
    debug_logging_enabled: false,
  };

  const initialSettings = initialOverrides.settings;
  if (initialSettings && typeof initialSettings === 'object') {
    Object.assign(settings, initialSettings);
  }

  const syncExperimentalEvSupportState = () => {
    const hasEvDevice = settings.target_devices_snapshot.some((device) => device.id === evDeviceSnapshot.id);
    const hasEvPlanDevice = Array.isArray(settings.plan_snapshot?.devices)
      && settings.plan_snapshot.devices.some((device) => device.id === evPlanDevice.id);

    if (settings.experimental_ev_support_enabled === true) {
      if (!hasEvDevice) {
        settings.target_devices_snapshot = [...settings.target_devices_snapshot, { ...evDeviceSnapshot }];
      }
      if (!hasEvPlanDevice) {
        settings.plan_snapshot = {
          ...settings.plan_snapshot,
          devices: [...(settings.plan_snapshot?.devices ?? []), { ...evPlanDevice }],
        };
      }
      return;
    }

    settings.target_devices_snapshot = settings.target_devices_snapshot.filter((device) => device.id !== evDeviceSnapshot.id);
    settings.plan_snapshot = {
      ...settings.plan_snapshot,
      devices: (settings.plan_snapshot?.devices ?? []).filter((device) => device.id !== evPlanDevice.id),
    };
    settings.managed_devices = {
      ...settings.managed_devices,
      [evDeviceSnapshot.id]: false,
    };
  };

  syncExperimentalEvSupportState();

  const buildPowerPayload = () => ({
    tracker: settings.power_tracker_state ?? null,
    status: settings.pels_status ?? null,
    heartbeat: typeof settings.app_heartbeat === 'number' ? settings.app_heartbeat : null,
  });

  const resolveDeadlinePlanMockupScenario = () => {
    try {
      return new URLSearchParams(window.location.search).get('scenario') || 'default';
    } catch {
      return 'default';
    }
  };

  const toLocalIsoHour = (startHour, index) => new Date(2026, 0, 1, startHour + index, 0, 0, 0).toISOString();

  const buildDeadlinePlanMockupPrices = (scenario) => {
    const rawPrices = scenario === 'priority1-cap-off'
      ? [94, 102, 131, 158, 172, 149, 108, 93, 61, 86, 58, 54, 82, 91, 49, 46, 88, 104, 138, 112, 98, 87, 79, 73, 76, 82, 91, 118, 142, 161, 149, 121, 94, 81, 76]
      : [102, 146, 62, 91, 135, 98, 55, 51, 89, 128, 104];
    const startHour = scenario === 'priority1-cap-off' ? 13 : 21;
    const sorted = [...rawPrices].sort((a, b) => a - b);
    const lowThreshold = sorted[Math.max(0, Math.floor(sorted.length * 0.25) - 1)] ?? rawPrices[0];
    const highThreshold = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75))] ?? rawPrices[rawPrices.length - 1];
    const prices = rawPrices.map((total, index) => ({
      startsAt: toLocalIsoHour(startHour, index),
      total,
      spotPriceExVat: total / 1.25,
      vatMultiplier: 1.25,
      vatAmount: total - total / 1.25,
      totalExVat: total / 1.25,
      isCheap: total <= lowThreshold,
      isExpensive: total >= highThreshold,
    }));
    return {
      prices,
      avgPrice: rawPrices.reduce((sum, price) => sum + price, 0) / rawPrices.length,
      lowThreshold,
      highThreshold,
      priceScheme: 'norway',
      priceUnit: 'øre/kWh',
    };
  };

  const buildPricesPayload = () => ({
    combinedPrices: buildDeadlinePlanMockupPrices(resolveDeadlinePlanMockupScenario()) ?? settings.combined_prices ?? null,
    electricityPrices: settings.electricity_prices ?? null,
    priceArea: typeof settings.price_area === 'string' ? settings.price_area : null,
    gridTariffData: settings.nettleie_data ?? null,
    flowToday: settings.flow_prices_today ?? null,
    flowTomorrow: settings.flow_prices_tomorrow ?? null,
    homeyCurrency: typeof settings.homey_prices_currency === 'string' ? settings.homey_prices_currency : null,
    homeyToday: settings.homey_prices_today ?? null,
    homeyTomorrow: settings.homey_prices_tomorrow ?? null,
  });

  const resolveDailyBudgetPayload = () => (
    runtimeOverrides.dailyBudgetPayload === undefined
      ? buildSampleDailyBudgetPayload()
      : runtimeOverrides.dailyBudgetPayload
  );

  const buildBootstrapSettings = () => ({
    capacity_limit_kw: settings.capacity_limit_kw,
    capacity_margin_kw: settings.capacity_margin_kw,
    capacity_dry_run: settings.capacity_dry_run,
    capacity_priorities: settings.capacity_priorities,
    mode_device_targets: settings.mode_device_targets,
    operating_mode: settings.operating_mode,
    controllable_devices: settings.controllable_devices,
    managed_devices: settings.managed_devices,
    budget_exempt_devices: settings.budget_exempt_devices,
    mode_aliases: settings.mode_aliases,
    overshoot_behaviors: settings.overshoot_behaviors,
    price_optimization_settings: settings.price_optimization_settings,
    price_optimization_enabled: settings.price_optimization_enabled,
    price_scheme: settings.price_scheme,
    norway_price_model: settings.norway_price_model,
    price_area: settings.price_area,
    provider_surcharge: settings.provider_surcharge,
    price_threshold_percent: settings.price_threshold_percent,
    price_min_diff_ore: settings.price_min_diff_ore,
    nettleie_fylke: settings.nettleie_fylke,
    nettleie_orgnr: settings.nettleie_orgnr,
    nettleie_tariffgruppe: settings.nettleie_tariffgruppe,
    daily_budget_enabled: settings.daily_budget_enabled,
    daily_budget_kwh: settings.daily_budget_kwh,
    daily_budget_price_shaping_enabled: settings.daily_budget_price_shaping_enabled,
    daily_budget_controlled_weight: settings.daily_budget_controlled_weight,
    daily_budget_price_flex_share: settings.daily_budget_price_flex_share,
    daily_budget_breakdown_enabled: settings.daily_budget_breakdown_enabled,
    debug_logging_topics: settings.debug_logging_topics,
    debug_logging_enabled: settings.debug_logging_enabled,
    experimental_ev_support_enabled: settings.experimental_ev_support_enabled,
    overview_redesign_enabled: settings.overview_redesign_enabled,
    device_control_profiles: settings.device_control_profiles,
    deferred_objective_preview: Object.prototype.hasOwnProperty.call(settings, 'deferred_objective_preview')
      ? settings.deferred_objective_preview
      : buildDeadlinePlanMockup(resolveDeadlinePlanMockupScenario()),
  });

  const buildDeadlinePlanMockup = (scenario) => {
    const withHorizonDetails = (hours, options = {}) => {
      const chargeIndexes = new Set(hours
        .map((hour, index) => hour.plan === 'Charge' ? index : -1)
        .filter((index) => index >= 0));
      let progress = options.startProgress ?? 42;
      const progressStep = options.progressStep ?? 8;
      return hours.map((hour, index) => {
        if (chargeIndexes.has(index)) {
          progress = Math.min(options.targetProgress ?? 80, progress + progressStep);
        }
        const otherKwh = options.otherKwh?.[index]
          ?? (index % 5 === 0 ? 2.6 : index % 3 === 0 ? 2.2 : 1.8)
          + (options.priorityOne ? 0 : index % 4 === 0 ? 1.8 : 1.0);
        const chargerKwh = hour.plan === 'Charge' ? (options.chargerKwh ?? 4.2) : 0;
        const hardCapKwh = options.hardCapKwh ?? 8;
        return {
          startsAt: toLocalIsoHour(options.startHour ?? 21, index),
          tone: hour.tone,
          plan: hour.plan,
          usage: { otherKwh, chargerKwh, hardCapKwh },
          progress,
        };
      });
    };

    const base = {
      hero: {
        chips: [
          { text: 'On track', tone: 'ok' },
          { text: 'Flexible target', tone: 'info' },
          { text: 'Price ready', tone: 'muted' },
        ],
        sectionLabel: "Tonight's charging plan",
        headline: 'Use 5 cheap hours and keep 2 fallback hours',
        subline: 'Needs 22 kWh · expected 4.2 kW · 10 hours left',
        decision: 'PELS waits for cheaper windows, but keeps recovery room if the charger is blocked.',
      },
      timeline: {
        title: 'Price and charging windows',
        subtitle: 'Known prices until tomorrow 07:00',
        ariaLabel: 'Hourly charging plan from 21:00 to 07:00',
        hours: withHorizonDetails([
          {},
          {},
          { plan: 'Charge' },
          { plan: 'Fallback' },
          {},
          {},
          { plan: 'Charge' },
          { plan: 'Charge' },
          { plan: 'Fallback' },
          {},
          { tone: 'deadline' },
        ], {
          startHour: 21,
          startProgress: 42,
          targetProgress: 80,
          progressStep: 9,
          otherKwh: [2.8, 3.9, 2.1, 2.5, 3.7, 2.8, 1.9, 1.8, 2.2, 3.3, 2.6],
        }),
        explainer: 'The first window takes one cheap hour and keeps a nearby fallback. The second window uses the cheapest late-night hours and keeps one recovery hour before the deadline.',
      },
      assumptions: {
        title: 'What the plan assumes',
        subtitle: 'These inputs decide how many fallback hours PELS keeps.',
        items: [
          { label: 'Charge estimate', description: '4.2 kW from the selected charger step', value: 'High' },
          { label: 'Energy per percent', description: '0.74 kWh for each battery percent', value: 'Learned' },
          { label: 'Priority risk', description: 'Two higher-priority devices may need available power', value: 'Medium' },
          { label: 'Background usage risk', description: 'Dinner and morning usage can reduce available power', value: 'Medium' },
        ],
      },
      risk: {
        title: 'Why fallback hours are included',
        subtitle: 'Priority changes confidence. It does not make expensive hours look cheap.',
        items: [
          { label: 'Price fit', value: 82 },
          { label: 'Charging confidence', value: 64, tone: 'warn' },
          { label: 'Deadline buffer', value: 72 },
        ],
        explainer: 'If a higher-priority device blocks the charger in a planned hour, the fallback hour can still keep the car on track without starting immediately at 21:00.',
      },
      comparison: {
        title: 'Similar goal, different safety model',
        items: [
          { label: 'Cheapest-hour scheduling', description: 'Pick the cheapest hours needed for the target.' },
          { label: 'PELS deadline planning', description: 'Pick cheap hours inside planning windows and keep fallback hours for blocked charging.' },
        ],
      },
    };

    if (scenario !== 'priority1-cap-off') return base;

    return {
      hero: {
        chips: [
          { text: 'On track', tone: 'ok' },
          { text: 'Priority 1', tone: 'info' },
          { text: 'Power-limit off', tone: 'muted' },
        ],
        sectionLabel: 'Target 80% by tomorrow 08:00',
        headline: 'Waiting by plan - first charging window starts at 21:00',
        subline: 'Needs 22 kWh · expected 5.0 kW · 19 hours left',
        decision: 'PELS can wait because enough lower-priced planned hours remain before the target.',
      },
      timeline: {
        title: 'Price and charging windows',
        subtitle: 'Known prices until target 08:00',
        ariaLabel: 'Known-price horizon from 13:00 today to target 08:00 tomorrow',
        hours: withHorizonDetails([
          {},
          {},
          {},
          {},
          {},
          {},
          {},
          {},
          { plan: 'Charge' },
          { plan: 'Fallback' },
          { plan: 'Charge' },
          { plan: 'Charge' },
          { plan: 'Fallback' },
          {},
          { plan: 'Charge' },
          { plan: 'Charge' },
          { plan: 'Fallback' },
          {},
          {},
          { tone: 'deadline' },
        ], {
          startHour: 13,
          priorityOne: true,
          startProgress: 42,
          targetProgress: 82,
          progressStep: 8,
          chargerKwh: 5,
          hardCapKwh: 10,
          otherKwh: [
            2.2, 2.1, 2.4, 2.8, 3.0, 2.7, 2.3, 2.0, 1.8, 1.7,
            1.6, 1.5, 1.4, 1.3, 1.4, 1.5, 1.8, 2.0, 2.4, 2.2,
          ],
        }),
        explainer: 'The objective targets 08:00. Fallback hours are reserves before the target, not guaranteed charging.',
      },
      assumptions: {
        title: 'What the plan assumes',
        subtitle: 'PELS schedules when the charger may run, but does not reduce it for capacity control.',
        items: [
          { label: 'Charger rate', description: '5.0 kW when the charger is allowed to run', value: 'Known' },
          { label: 'Priority', description: 'Priority 1 means no managed device is ahead of this charger', value: 'Low risk' },
          { label: 'Daily budget', description: '80 kWh budget leaves enough room for a 22 kWh charging plan', value: 'Ready' },
          { label: 'Power-limit control', description: 'Off - schedule controls when it runs; capacity control does not throttle it.', value: 'Off' },
        ],
      },
      risk: {
        title: 'Why fallback hours are included',
        subtitle: 'Priority 1 lowers blocking risk; the longer horizon still keeps recovery hours.',
        items: [
          { label: 'Price fit', value: 88 },
          { label: 'Charging confidence', value: 92 },
          { label: 'Planned load', value: 78 },
        ],
      },
      comparison: base.comparison,
    };
  };

  const apiHandlers = {
    'GET /daily_budget': () => resolveDailyBudgetPayload(),
    'GET /homey_devices': () => {
      // Used by advanced device logger/cleanup.
      return [
        { id: 'dev_heatpump', name: 'Living Room Heat Pump' },
        { id: 'dev_floorheat', name: 'Bathroom Floor Heat' },
        { id: 'dev_waterheater', name: 'Water Heater' },
        { id: 'dev_evcharger', name: 'Generic EV Charger' },
      ];
    },
    'GET /ui_bootstrap': () => ({
      settings: buildBootstrapSettings(),
      dailyBudget: resolveDailyBudgetPayload(),
      featureAccess: initialOverrides.featureAccess ?? { canToggleOverviewRedesign: true },
      devices: settings.target_devices_snapshot,
      plan: settings.plan_snapshot,
      power: buildPowerPayload(),
      prices: buildPricesPayload(),
    }),
    'GET /ui_devices': () => ({
      devices: settings.target_devices_snapshot,
    }),
    'GET /ui_plan': () => ({
      plan: settings.plan_snapshot,
    }),
    'GET /ui_power': () => buildPowerPayload(),
    'GET /ui_prices': () => buildPricesPayload(),
    'POST /settings_ui_log': () => ({ ok: true }),
    'POST /log_homey_device': () => ({ ok: true }),
  };

  const api = (method, uri, bodyOrCallback, cbMaybe) => {
    let callback = cbMaybe;
    if (typeof bodyOrCallback === 'function') {
      callback = bodyOrCallback;
    }

    const key = `${String(method).toUpperCase()} ${uri}`;
    const handler = runtimeOverrides.apiHandlers[key] ?? apiHandlers[key];
    runtimeOverrides.apiCallCounts[key] = (runtimeOverrides.apiCallCounts[key] ?? 0) + 1;

    setTimeout(() => {
      if (typeof callback !== 'function') return;
      try {
        if (!handler) {
          callback(new Error(`Homey stub: no handler for ${key}`));
          return;
        }
        callback(null, handler());
      } catch (err) {
        callback(err);
      }
    }, 10);
  };

  const Homey = {
    ready: async () => {},

    on: (event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },

    get: (key, cb) => {
      setTimeout(() => {
        cb(null, settings[key]);
      }, 5);
    },

    set: (key, value, cb) => {
      settings[key] = value;
      const followUpKeys = [];
      let emitDevicesUpdated = false;
      if (key === 'experimental_ev_support_enabled') {
        syncExperimentalEvSupportState();
        followUpKeys.push('managed_devices');
        emitDevicesUpdated = true;
      }
      setTimeout(() => {
        cb(null);
        emit('settings.set', key);
        followUpKeys.forEach((nextKey) => emit('settings.set', nextKey));
        if (emitDevicesUpdated) emit('devices_updated', null);
      }, 5);
    },

    api,

    clock: {
      getTimezone: () => 'UTC',
    },

    i18n: {
      getTimezone: () => 'UTC',
    },

    __stub: {
      setDailyBudgetPayload: (payload) => {
        runtimeOverrides.dailyBudgetPayload = payload;
      },
      getDailyBudgetPayload: () => runtimeOverrides.dailyBudgetPayload,
      getApiCallCount: (key) => runtimeOverrides.apiCallCounts[key] ?? 0,
      setApiHandler: (key, handler) => {
        runtimeOverrides.apiHandlers[key] = handler;
      },
      clearApiHandler: (key) => {
        delete runtimeOverrides.apiHandlers[key];
      },
      emitSettingsSet: (key) => {
        emit('settings.set', key);
      },
      setSetting: (key, value) => {
        settings[key] = value;
      },
      getSetting: (key) => settings[key],
    },
  };

  // Expose globally.
  window.Homey = Homey;
})();
