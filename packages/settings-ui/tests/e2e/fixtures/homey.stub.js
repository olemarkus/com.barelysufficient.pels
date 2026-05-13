(() => {
  const listeners = Object.create(null);
  const initialOverrides = (
    window.__PELS_HOMEY_STUB__ && typeof window.__PELS_HOMEY_STUB__ === 'object'
  )
    ? window.__PELS_HOMEY_STUB__
    : {};
  const hasInitialDailyBudgetPayload = Object.prototype.hasOwnProperty.call(initialOverrides, 'dailyBudgetPayload');

  // Keep seeding the legacy browser preference for older fixtures; production code now
  // keeps the redesigned UI on regardless of this value.
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

  const deadlineMsAfterHours = (hours) => Date.now() + hours * 3600 * 1000;

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
    const currentHourIso = new Date(startOfUtcHourMs(now)).toISOString();
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
      deviceBuckets: {
        dev_connected300: {
          [currentHourIso]: 0.8,
        },
      },
      lastDevicePowerWById: {
        dev_connected300: 1500,
      },
      objectiveProfiles: {
        dev_connected300: {
          kind: 'temperature',
          updatedAtMs: Date.now(),
          lastSample: {
            observedAtMs: Date.now() - 10 * 60 * 1000,
            value: 51.1,
            unit: 'degree_c',
          },
          kwhPerUnit: {
            sampleCount: 12,
            mean: 0.8,
            m2: 0,
            min: 0.6,
            max: 1.1,
            confidence: 'high',
            lastUpdatedMs: Date.now() - 10 * 60 * 1000,
          },
          acceptedSamples: 12,
          rejectedSamples: 1,
        },
      },
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
        hourBudgetKWh: 4.5,
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
          plannedControlledKWh: plannedKWh.map((value) => Number((value * 0.4).toFixed(3))),
          plannedUncontrolledKWh: plannedKWh.map((value) => Number((value * 0.6).toFixed(3))),
          actualKWh,
          actualControlledKWh: actualKWh.map((value, i) => (
            i <= currentBucketIndex ? Number((value * 0.4).toFixed(3)) : null
          )),
          actualUncontrolledKWh: actualKWh.map((value, i) => (
            i <= currentBucketIndex ? Number((value * 0.6).toFixed(3)) : null
          )),
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
    deferred_objectives: {
      version: 1,
      objectivesByDeviceId: {
        dev_connected300: {
          enabled: true,
          kind: 'temperature',
          enforcement: 'soft',
          targetTemperatureC: 65,
          deadlineAtMs: deadlineMsAfterHours(8),
        },
      },
    },

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

  const ensureEvSupportState = () => {
    const hasEvDevice = settings.target_devices_snapshot.some((device) => device.id === evDeviceSnapshot.id);
    const hasEvPlanDevice = Array.isArray(settings.plan_snapshot?.devices)
      && settings.plan_snapshot.devices.some((device) => device.id === evPlanDevice.id);

    if (!hasEvDevice) {
      settings.target_devices_snapshot = [...settings.target_devices_snapshot, { ...evDeviceSnapshot }];
    }
    if (!hasEvPlanDevice) {
      settings.plan_snapshot = {
        ...settings.plan_snapshot,
        devices: [...(settings.plan_snapshot?.devices ?? []), { ...evPlanDevice }],
      };
    }
  };

  ensureEvSupportState();

  const buildPowerPayload = () => ({
    tracker: settings.power_tracker_state ?? null,
    status: settings.pels_status ?? null,
    heartbeat: typeof settings.app_heartbeat === 'number' ? settings.app_heartbeat : null,
  });

  const buildPricesPayload = () => ({
    combinedPrices: settings.combined_prices ?? null,
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

  // Build a candidate payload that visibly reflects the requested model
  // settings: scale plannedKWh proportionally to the new daily budget so the
  // comparison charts in the UI show a real difference, then update the per-day
  // budget block. Other fields are left untouched.
  const scaleBudgetPayload = (source, candidateSettings) => {
    if (!source || !source.days) return source;
    const oldBudget = Number(source.days[source.todayKey]?.budget?.dailyBudgetKWh ?? 0);
    const newBudget = Number(candidateSettings.dailyBudgetKWh ?? oldBudget);
    const ratio = oldBudget > 0 ? newBudget / oldBudget : 1;
    const days = {};
    for (const [key, day] of Object.entries(source.days)) {
      const buckets = { ...day.buckets };
      if (Array.isArray(buckets.plannedKWh)) {
        buckets.plannedKWh = buckets.plannedKWh.map((v) => Number(((v ?? 0) * ratio).toFixed(3)));
      }
      if (Array.isArray(buckets.allowedCumKWh)) {
        buckets.allowedCumKWh = buckets.allowedCumKWh.map((v) => Number(((v ?? 0) * ratio).toFixed(3)));
      }
      days[key] = {
        ...day,
        budget: {
          ...day.budget,
          enabled: Boolean(candidateSettings.enabled),
          dailyBudgetKWh: newBudget,
          priceShapingEnabled: Boolean(candidateSettings.priceShapingEnabled),
        },
        buckets,
      };
    }
    return { ...source, days };
  };

  const buildSampleActivePlans = () => {
    const objective = settings.deferred_objectives?.objectivesByDeviceId?.dev_connected300;
    if (!objective?.enabled) return { version: 1, plansByDeviceId: {} };
    const nowMs = Date.now();
    const startsAtMs = startOfUtcHourMs(new Date(nowMs));
    const deadlineAtMs = typeof objective.deadlineAtMs === 'number'
      ? objective.deadlineAtMs
      : nowMs + 8 * 3600 * 1000;
    // Pick the first 6 cheap-or-neutral hours within the horizon as planned hours.
    const hourMs = 3600 * 1000;
    const totalHoursAvailable = Math.max(1, Math.floor((deadlineAtMs - startsAtMs) / hourMs));
    const plannedHourCount = Math.min(6, totalHoursAvailable);
    const hours = [];
    for (let i = 0; i < plannedHourCount; i += 1) {
      hours.push({ startsAtMs: startsAtMs + i * hourMs, plannedKWh: 2 });
    }
    const latestHours = plannedHourCount < totalHoursAvailable
      ? hours.slice(1).concat([{ startsAtMs: startsAtMs + plannedHourCount * hourMs, plannedKWh: 2 }])
      : hours;
    const revision = {
      revision: 1,
      revisedAtMs: nowMs,
      computedFromPricesUpTo: deadlineAtMs,
      reason: 'flow_card',
      hours,
      energyNeededKWh: plannedHourCount * 2,
      planStatus: 'on_track',
    };
    const latestRevision = latestHours === hours ? revision : {
      ...revision,
      revision: 2,
      revisedAtMs: nowMs + 60 * 1000,
      reason: 'prices_revised',
      hours: latestHours,
    };
    return {
      version: 1,
      plansByDeviceId: {
        dev_connected300: {
          deviceId: 'dev_connected300',
          deviceName: 'Connected 300',
          objectiveKind: objective.kind ?? 'temperature',
          targetTemperatureC: typeof objective.targetTemperatureC === 'number' ? objective.targetTemperatureC : null,
          targetPercent: typeof objective.targetPercent === 'number' ? objective.targetPercent : null,
          deadlineAtMs,
          startedAtMs: nowMs,
          pending: false,
          objectiveSignature: 'stub',
          original: revision,
          latest: latestRevision,
        },
      },
    };
  };

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
    overview_redesign_enabled: settings.overview_redesign_enabled,
    device_control_profiles: settings.device_control_profiles,
    deferred_objectives: settings.deferred_objectives,
  });

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
      deferredObjectiveActivePlans: buildSampleActivePlans(),
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
    'POST /ui_preview_daily_budget_model': (body) => {
      const activePayload = resolveDailyBudgetPayload();
      const candidateSettings = {
        enabled: Boolean(body?.enabled),
        dailyBudgetKWh: Number(body?.dailyBudgetKWh ?? settings.daily_budget_kwh ?? 0),
        priceShapingEnabled: body?.priceShapingEnabled !== false,
        controlledUsageWeight: Number(body?.controlledUsageWeight ?? settings.daily_budget_controlled_weight ?? 0),
        priceShapingFlexShare: Number(body?.priceShapingFlexShare ?? settings.daily_budget_price_flex_share ?? 0),
      };
      const candidatePayload = scaleBudgetPayload(activePayload, candidateSettings);
      return {
        active: activePayload,
        candidate: candidatePayload,
        settings: candidateSettings,
      };
    },
    'POST /ui_apply_daily_budget_model': (body) => {
      if (body?.enabled !== undefined) settings.daily_budget_enabled = Boolean(body.enabled);
      if (body?.dailyBudgetKWh !== undefined) settings.daily_budget_kwh = Number(body.dailyBudgetKWh);
      if (body?.priceShapingEnabled !== undefined) {
        settings.daily_budget_price_shaping_enabled = Boolean(body.priceShapingEnabled);
      }
      if (body?.controlledUsageWeight !== undefined) {
        settings.daily_budget_controlled_weight = Number(body.controlledUsageWeight);
      }
      if (body?.priceShapingFlexShare !== undefined) {
        settings.daily_budget_price_flex_share = Number(body.priceShapingFlexShare);
      }
      return resolveDailyBudgetPayload();
    },
  };

  const api = (method, uri, bodyOrCallback, cbMaybe) => {
    let callback = cbMaybe;
    let body;
    if (typeof bodyOrCallback === 'function') {
      callback = bodyOrCallback;
    } else {
      body = bodyOrCallback;
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
        callback(null, handler(body));
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
      setTimeout(() => {
        cb(null);
        emit('settings.set', key);
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
      emitHomeyEvent: (event, ...args) => {
        emit(event, ...args);
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
