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
    // Active audit scenario (one of `AUDIT_SCENARIO_NAMES` in
    // `packages/settings-ui/test/helpers/auditScenarios.ts`). null means
    // baseline; a scenario flips API responses at the SDK boundary so the same
    // settings UI code renders an alternate state. See `notes/browser-stub.md`
    // for the full scenario list and intent.
    scenarioName: null,
    scenarioPatch: null,
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
          // `steppedLoad` mirrors the runtime SettingsUiPlanSteppedLoadState
          // shape so the plan card renders the StepRail. Profile values match
          // a real Zaptec Go (6 A–32 A, plus a synthesized `off` step inserted
          // by the rail when missing); this is the long-tail rail the 320 px
          // overflow + ampere-label regressions show up on.
          steppedLoad: {
            profile: {
              model: 'stepped_load',
              steps: [
                { id: '6a', planningPowerW: 1380 },
                { id: '8a', planningPowerW: 1840 },
                { id: '10a', planningPowerW: 2300 },
                { id: '12a', planningPowerW: 2760 },
                { id: '14a', planningPowerW: 3220 },
                { id: '16a', planningPowerW: 3680 },
                { id: '20a', planningPowerW: 4600 },
                { id: '24a', planningPowerW: 5520 },
                { id: '28a', planningPowerW: 6440 },
                { id: '32a', planningPowerW: 7360 },
              ],
            },
            reportedStepId: '6a',
            targetStepId: '6a',
            commandPending: false,
          },
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
          steppedLoad: {
            profile: {
              model: 'stepped_load',
              steps: [
                { id: 'low', planningPowerW: 750 },
                { id: 'medium', planningPowerW: 1500 },
                { id: 'high', planningPowerW: 2000 },
              ],
            },
            reportedStepId: 'low',
            targetStepId: 'low',
            commandPending: false,
          },
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

  const buildPowerPayload = () => {
    // Branch on `!== undefined` (not `?? baseline`) so a scenario can force a
    // null power payload to exercise the "power feed missing" UI state.
    const scenarioPatch = runtimeOverrides.scenarioPatch;
    if (scenarioPatch && Object.prototype.hasOwnProperty.call(scenarioPatch, 'power')) {
      return scenarioPatch.power;
    }
    return {
      tracker: settings.power_tracker_state ?? null,
      status: settings.pels_status ?? null,
      heartbeat: typeof settings.app_heartbeat === 'number' ? settings.app_heartbeat : null,
    };
  };

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

  const buildPlanPayload = () => {
    // Branch on `hasOwnProperty` so a scenario can force a null plan (used to
    // exercise the "no plan yet" UI state); `?? baseline` would mask that.
    const scenarioPatch = runtimeOverrides.scenarioPatch;
    if (scenarioPatch && Object.prototype.hasOwnProperty.call(scenarioPatch, 'plan')) {
      return scenarioPatch.plan;
    }
    return settings.plan_snapshot;
  };

  const resolveDailyBudgetPayload = () => {
    // Direct runtime override (set via `__stub.setDailyBudgetPayload`) wins so
    // existing tests that pin a specific payload keep working.
    if (runtimeOverrides.dailyBudgetPayload !== undefined) {
      return runtimeOverrides.dailyBudgetPayload;
    }
    const scenarioBudget = runtimeOverrides.scenarioPatch?.dailyBudget;
    if (scenarioBudget !== undefined) return scenarioBudget;
    return buildSampleDailyBudgetPayload();
  };

  const resolveActivePlansPayload = () => {
    const scenarioPlans = runtimeOverrides.scenarioPatch?.deferredObjectiveActivePlans;
    if (scenarioPlans !== undefined) return scenarioPlans;
    return buildSampleActivePlans();
  };

  const resolveDeferredObjectiveHistoryPayload = () => {
    const scenarioHistory = runtimeOverrides.scenarioPatch?.deferredObjectiveHistory;
    if (scenarioHistory !== undefined) return scenarioHistory;
    return { version: 1, entriesByDeviceId: {} };
  };

  const resolveDeviceDiagnosticsPayload = () => {
    const scenarioDiagnostics = runtimeOverrides.scenarioPatch?.deviceDiagnostics;
    if (scenarioDiagnostics !== undefined) return scenarioDiagnostics;
    return {
      generatedAt: Date.now(),
      windowDays: 21,
      diagnosticsByDeviceId: {},
    };
  };

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
      deferredObjectiveActivePlans: resolveActivePlansPayload(),
      devices: settings.target_devices_snapshot,
      plan: buildPlanPayload(),
      power: buildPowerPayload(),
      prices: buildPricesPayload(),
    }),
    'GET /ui_devices': () => ({
      devices: settings.target_devices_snapshot,
    }),
    'GET /ui_plan': () => ({
      plan: buildPlanPayload(),
    }),
    'GET /ui_power': () => buildPowerPayload(),
    'GET /ui_prices': () => buildPricesPayload(),
    'GET /ui_device_diagnostics': () => resolveDeviceDiagnosticsPayload(),
    'GET /ui_deferred_objective_history': () => resolveDeferredObjectiveHistoryPayload(),
    // Objectives moved to per-device keys; the UI's loadDeferredObjectiveSettings
    // now reads this endpoint (the legacy blob is consumed by the migration). The
    // stub doesn't model per-key storage, so serve the same assembled map the
    // bootstrap exposes.
    'GET /ui_deferred_objective_settings': () => (
      settings.deferred_objectives ?? { version: 1, objectivesByDeviceId: {} }
    ),
    'POST /settings_ui_log': () => ({ ok: true }),
    'POST /log_homey_device': () => ({ ok: true }),
    'POST /ui_refresh_devices': () => ({
      devices: settings.target_devices_snapshot,
    }),
    'POST /ui_refresh_prices': () => buildPricesPayload(),
    'POST /ui_refresh_grid_tariff': () => buildPricesPayload(),
    'POST /ui_recompute_daily_budget': () => resolveDailyBudgetPayload(),
    'POST /ui_reset_power_stats': () => ({
      power: buildPowerPayload(),
      dailyBudget: resolveDailyBudgetPayload(),
    }),
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

  // ----------------------------------------------------------------------
  // Browser audit scenarios.
  //
  // Each scenario is a factory returning a "patch" object that the resolvers
  // above consult at the Homey SDK boundary. Scenarios MUST mirror the names
  // and intent of `AUDIT_SCENARIO_NAMES` /
  // `packages/settings-ui/test/helpers/auditScenarios.ts`. The unit test
  // `auditScenarios.test.ts` enforces parity — if you add a scenario here
  // without adding it there (or vice-versa) the parity test fails.
  //
  // Why duplicate? The browser stub is plain JS served verbatim by the static
  // server; importing TS at runtime would require a bundler step on the
  // fixture path. The parity test is the lower-cost way to keep them aligned.
  // ----------------------------------------------------------------------
  const HOUR_MS = 3600 * 1000;

  const buildScenarioOverBudgetDailyBudget = () => {
    const nowMs = Date.now();
    const dayStartMs = Date.UTC(
      new Date(nowMs).getUTCFullYear(),
      new Date(nowMs).getUTCMonth(),
      new Date(nowMs).getUTCDate(),
      0, 0, 0,
    );
    const perBucketKWh = 0.5;
    const actualMultiplier = 1.8;
    const dailyBudgetKWh = 12;
    const startUtc = [];
    const startLocalLabels = [];
    const plannedKWh = [];
    const actualKWh = [];
    const allowedCumKWh = [];
    const price = [];
    let cum = 0;
    // Pin to bucket 18 (~16.2 kWh cumulative actual) so `exceeded` is true
    // regardless of wall-clock time — keeps the over-budget chip stable for
    // screenshot audits run at any hour. See the matching helper-side
    // comment in `packages/settings-ui/test/helpers/auditScenarios.ts`.
    const currentBucketIndex = 18;
    for (let i = 0; i < 24; i += 1) {
      startUtc.push(new Date(dayStartMs + i * HOUR_MS).toISOString());
      startLocalLabels.push(String(i).padStart(2, '0'));
      plannedKWh.push(perBucketKWh);
      actualKWh.push(Number((perBucketKWh * actualMultiplier).toFixed(3)));
      cum += perBucketKWh;
      allowedCumKWh.push(Number(cum.toFixed(3)));
      price.push(Number((80 + 35 * Math.sin((i / 24) * Math.PI * 2 - Math.PI / 2)).toFixed(1)));
    }
    const usedNowKWh = actualKWh.slice(0, currentBucketIndex + 1).reduce((sum, v) => sum + v, 0);
    const allowedNowKWh = allowedCumKWh[currentBucketIndex] ?? 0;
    const remainingKWh = dailyBudgetKWh - usedNowKWh;
    const dateKey = dateKeyUtc(dayStartMs);
    return {
      days: {
        [dateKey]: {
          dateKey,
          timeZone: 'UTC',
          nowUtc: new Date(nowMs).toISOString(),
          dayStartUtc: new Date(dayStartMs).toISOString(),
          currentBucketIndex,
          budget: { enabled: true, dailyBudgetKWh, priceShapingEnabled: true },
          state: {
            usedNowKWh: Number(usedNowKWh.toFixed(3)),
            allowedNowKWh: Number(allowedNowKWh.toFixed(3)),
            remainingKWh: Number(remainingKWh.toFixed(3)),
            deviationKWh: Number((usedNowKWh - allowedNowKWh).toFixed(3)),
            exceeded: remainingKWh < 0,
            frozen: false,
            confidence: 0.72,
            priceShapingActive: true,
          },
          buckets: {
            startUtc,
            startLocalLabels,
            plannedWeight: Array.from({ length: 24 }, () => 1),
            plannedKWh,
            plannedControlledKWh: plannedKWh.map((v) => Number((v * 0.4).toFixed(3))),
            plannedUncontrolledKWh: plannedKWh.map((v) => Number((v * 0.6).toFixed(3))),
            actualKWh,
            actualControlledKWh: actualKWh.map((v, i) => (i <= currentBucketIndex ? Number((v * 0.4).toFixed(3)) : null)),
            actualUncontrolledKWh: actualKWh.map((v, i) => (i <= currentBucketIndex ? Number((v * 0.6).toFixed(3)) : null)),
            allowedCumKWh,
            price,
          },
        },
      },
      todayKey: dateKey,
      tomorrowKey: null,
      yesterdayKey: null,
    };
  };

  const buildScenarioMissingPriceDailyBudget = () => {
    const overBudget = buildScenarioOverBudgetDailyBudget();
    const today = overBudget.days[overBudget.todayKey];
    // Cleaner usage curve (not over-budget) but null prices.
    const actualKWh = today.buckets.actualKWh.map((_, i) => (i <= today.currentBucketIndex ? Number((0.5 * 0.95).toFixed(3)) : 0));
    return {
      ...overBudget,
      days: {
        [today.dateKey]: {
          ...today,
          state: {
            ...today.state,
            usedNowKWh: Number(actualKWh.slice(0, today.currentBucketIndex + 1).reduce((s, v) => s + v, 0).toFixed(3)),
            exceeded: false,
            priceShapingActive: true,
          },
          buckets: {
            ...today.buckets,
            actualKWh,
            actualControlledKWh: actualKWh.map((v, i) => (i <= today.currentBucketIndex ? Number((v * 0.4).toFixed(3)) : null)),
            actualUncontrolledKWh: actualKWh.map((v, i) => (i <= today.currentBucketIndex ? Number((v * 0.6).toFixed(3)) : null)),
            price: Array.from({ length: 24 }, () => null),
          },
        },
      },
    };
  };

  const buildScenarioPressurePlan = () => ({
    meta: {
      totalKw: 8.6,
      softLimitKw: 8.0,
      capacitySoftLimitKw: 8.0,
      hardLimitKw: 8.0,
      softLimitSource: 'capacity',
      headroomKw: 0,
      powerKnown: true,
      hasLivePowerSample: true,
      capacityShortfall: true,
      shortfallBudgetThresholdKw: 8.0,
      shortfallBudgetHeadroomKw: 0,
      hardCapLimitKw: 8.0,
      hardCapHeadroomKw: 0,
      usedKWh: 3.8,
      budgetKWh: 4.5,
      hourBudgetKWh: 4.5,
      minutesRemaining: 14,
      controlledKw: 6.3,
      uncontrolledKw: 2.3,
      hourControlledKWh: 1.6,
      hourUncontrolledKWh: 0.6,
    },
    devices: [
      {
        id: 'dev_waterheater',
        name: 'Water Heater',
        currentState: 'on',
        plannedState: 'shed',
        priority: 2,
        controllable: true,
        expectedPowerKw: 2.0,
        measuredPowerKw: 2.1,
        reason: { code: 'capacity', detail: 'capacity shortfall' },
        shedAction: 'turn_off',
      },
      {
        id: 'dev_evcharger',
        name: 'Generic EV Charger',
        currentState: 'on',
        plannedState: 'shed',
        priority: 6,
        controllable: true,
        expectedPowerKw: 7.2,
        measuredPowerKw: 6.8,
        reason: { code: 'capacity', detail: 'capacity shortfall' },
        shedAction: 'turn_off',
      },
    ],
  });

  const buildScenarioPressurePower = () => ({
    tracker: null,
    status: {
      capacityShortfall: true,
      shortfallBudgetThresholdKw: 8.0,
      shortfallBudgetHeadroomKw: 0,
      hardCapHeadroomKw: 0,
      headroomKw: 0,
      powerKnown: true,
      hasLivePowerSample: true,
      powerFreshnessState: 'fresh',
      lastPowerUpdate: Date.now() - 5 * 1000,
    },
    heartbeat: Date.now() - 4 * 1000,
  });

  const buildScenarioDenseDevicePlan = () => {
    const devices = [];
    for (let i = 0; i < 12; i += 1) {
      devices.push({
        id: `dev_room_${i + 1}`,
        name: `Room ${i + 1} Thermostat`,
        currentState: i % 3 === 0 ? 'off' : 'on',
        plannedState: 'keep',
        controlModel: 'temperature_target',
        deviceClass: 'thermostat',
        currentTarget: 21,
        plannedTarget: 21,
        currentTemperature: 19 + (i % 5),
        priority: 1 + (i % 5),
        controllable: true,
        expectedPowerKw: 0.4,
        measuredPowerKw: i % 3 === 0 ? 0 : 0.32,
        reason: { code: 'keep', detail: null },
        shedAction: 'set_temperature',
        shedTemperature: 15,
      });
    }
    return {
      meta: {
        totalKw: 4.7,
        softLimitKw: 8.0,
        capacitySoftLimitKw: 8.0,
        hardLimitKw: 8.0,
        softLimitSource: 'capacity',
        headroomKw: 3.3,
        powerKnown: true,
        hasLivePowerSample: true,
        usedKWh: 1.2,
        budgetKWh: 4.5,
        hourBudgetKWh: 4.5,
        minutesRemaining: 33,
        controlledKw: 2.5,
        uncontrolledKw: 2.2,
        hourControlledKWh: 0.6,
        hourUncontrolledKWh: 0.6,
      },
      devices,
    };
  };

  const BROWSER_AUDIT_SCENARIOS = {
    normal: () => ({
      description: 'Baseline state matching stub defaults.',
    }),
    pressure: () => ({
      description: 'Capacity guard active; soft limit exceeded; shed planned.',
      plan: buildScenarioPressurePlan(),
      power: buildScenarioPressurePower(),
    }),
    'over-budget': () => ({
      description: 'Daily budget exhausted; actual far above planned.',
      settings: {
        daily_budget_enabled: true,
        daily_budget_kwh: 12,
        daily_budget_price_shaping_enabled: true,
      },
      dailyBudget: buildScenarioOverBudgetDailyBudget(),
    }),
    'missing-price': () => ({
      description: 'Price feed unavailable; combined/electricity/homey prices all null.',
      settings: {
        combined_prices: null,
        electricity_prices: null,
        homey_prices_today: null,
        homey_prices_tomorrow: null,
        flow_prices_today: null,
        flow_prices_tomorrow: null,
      },
      dailyBudget: buildScenarioMissingPriceDailyBudget(),
    }),
    'empty-history': () => ({
      description: 'No smart-task history yet; active plans empty.',
      deferredObjectiveActivePlans: { version: 1, plansByDeviceId: {} },
      deferredObjectiveHistory: { version: 1, entriesByDeviceId: {} },
    }),
    'dense-device': () => ({
      description: 'Twelve controllable thermostats for scroll-density audits.',
      plan: buildScenarioDenseDevicePlan(),
    }),
  };

  const applyAuditScenario = (name) => {
    if (name === null || name === undefined) {
      runtimeOverrides.scenarioName = null;
      runtimeOverrides.scenarioPatch = null;
      return;
    }
    const factory = BROWSER_AUDIT_SCENARIOS[name];
    if (!factory) {
      throw new Error(`Unknown audit scenario "${name}". Known: ${Object.keys(BROWSER_AUDIT_SCENARIOS).join(', ')}.`);
    }
    const patch = factory();
    runtimeOverrides.scenarioName = name;
    runtimeOverrides.scenarioPatch = patch;
    if (patch.settings && typeof patch.settings === 'object') {
      Object.assign(settings, patch.settings);
    }
  };

  // Apply scenario at boot if requested. Done before listeners are wired so
  // the first bootstrap fetch sees the scenario shape.
  if (typeof initialOverrides.scenario === 'string') {
    applyAuditScenario(initialOverrides.scenario);
  }

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
      // Audit scenario API. Names mirror `AUDIT_SCENARIO_NAMES` in
      // `packages/settings-ui/test/helpers/auditScenarios.ts`. See
      // `notes/browser-stub.md`.
      listAuditScenarios: () => Object.keys(BROWSER_AUDIT_SCENARIOS),
      applyAuditScenario: (name) => applyAuditScenario(name),
      clearAuditScenario: () => applyAuditScenario(null),
      getActiveAuditScenario: () => runtimeOverrides.scenarioName,
    },
  };

  // Expose globally. Two paths matter here:
  //   1. `window.Homey = Homey` — legacy global fallback. `waitForHomey()` in
  //      `packages/settings-ui/src/ui/homey.ts` polls this if the ready promise
  //      never resolves, and a handful of tests still read it directly.
  //   2. `window.onHomeyReady(Homey)` — the path Homey's injected settings SDK
  //      uses in production (`/homey.js` calls it once it has built the client).
  //      `public/index.html` wires that callback to resolve
  //      `window.__PELS_HOMEY_READY__`, which is the preferred entry point.
  // Keeping both means full-browser audits exercise the production handoff
  // while existing tests that rely on the global keep working.
  window.Homey = Homey;
  if (typeof window.onHomeyReady === 'function') {
    try {
      window.onHomeyReady(Homey);
    } catch (e) {
      console.error('[homey.stub] onHomeyReady threw', e);
    }
  }
})();
