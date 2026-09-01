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
    // Pinned weather readout (any state, incl. null) — undefined means "build
    // the sample ready payload from the weather_advisor_settings flag".
    weatherReadout: Object.prototype.hasOwnProperty.call(initialOverrides, 'weatherReadout')
      ? initialOverrides.weatherReadout
      : undefined,
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
      // The default story is a healthy MEASURED home: the live latch mirrors
      // production `recordPowerSample`, which stamps `lastPowerW` and
      // `lastTimestamp` together. `buildPowerPayload` classifies the status
      // read on this latch exactly like the real producer, so without it the
      // whole suite would render the gated `no_measurement` state.
      lastPowerW: 5200,
      lastTimestamp: Date.now() - 12 * 1000,
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
        lastPowerUpdateMs: Date.now() - 5 * 1000,
        softLimitKw: 2.3,
        capacitySoftLimitKw: 2.3,
        hardCapLimitKw: 8.0,
        budgetPaceKw: null,
        projectedExemptKw: null,
        softLimitSource: 'capacity',
        headroomKw: 0.8,
        usedKWh: 0.26,
        hourBudgetKWh: 4.5,
        minutesRemaining: 48,
        // Keep the split consistent with the device list below: the heat pump
        // is managed and measured at 1.2 kW of the 1.5 kW total. A 0.0 here
        // renders "Managed 0.0 kW" above a visibly running managed device on
        // every default-fixture screenshot (pels-ux-fit, PR #1970).
        controlledKw: 1.2,
        uncontrolledKw: 0.3,
        hourControlledKWh: 0.0,
        hourUncontrolledKWh: 0.11,
      },
      devices: [
        {
          id: 'dev_heatpump',
          name: 'Living Room Heat Pump',
          currentState: 'on',
          plannedState: 'keep',
          // The producer emits the observational kind; the temperature card keys on
          // this, not on a resolved control model.
          deviceType: 'temperature',
          deviceClass: 'thermostat',
          // `currentTarget` is the OBSERVED device target (the device fixture
          // reports 22); `plannedTarget` is planner-owned and follows the
          // active Home mode (21, see mode_device_targets). They legitimately
          // differ mid-transition, and the card grammar renders the honest
          // arrow form (`target 22 °C → 21 °C`) — a fixture that forces them
          // equal hides that state, and one that diverges them with NO arrow
          // (the old 22/22 against a 21 mode row) reads as numbers that
          // don't reconcile.
          temperature: { currentTarget: 22, currentTemperature: 20.3, plannedTarget: 21 },
          priority: 1,
          controllable: true,
          available: true,
          expectedPowerKw: 1.6,
          currentDrawKw: 1.2,
          reason: { code: 'keep', detail: null },
          shedAction: 'set_temperature',
          shedTemperature: 16,
        },
        {
          id: 'dev_waterheater',
          // Required on the plan snapshot: a binary load the owner sheds by turning off.
          name: 'Water Heater',
          currentState: 'on',
          plannedState: 'shed',
          priority: 2,
          controllable: true,
          available: true,
          expectedPowerKw: 2.0,
          currentDrawKw: 2.1,
          // Production capacity sheds carry the recomputed, swap-aware
          // shortfall (PR #1973); without it the hero/card reason ladder can
          // only render its bare fallback, so no capture ever proved the
          // "N kW more needed" clause.
          reason: { code: 'capacity', detail: 'high household load', shortfallKw: 0.8 },
          shedAction: 'turn_off',
        },
        {
          id: 'dev_poolpump',
          // Required on the plan snapshot: a binary load the owner sheds by turning off.
          name: 'Pool Pump',
          // Surplus-held dump load ("Run on solar surplus" posture): baseline
          // off, waiting for export — the card reads "Waiting for solar surplus".
          currentState: 'off',
          plannedState: 'shed',
          priority: 2,
          controllable: true,
          available: true,
          surplusOnly: true,
          expectedPowerKw: 1.0,
          currentDrawKw: 0,
          reason: { code: 'awaiting_solar_surplus', detail: null },
          shedAction: 'turn_off',
        },
        {
          id: 'dev_bedroom',
          name: 'Bedroom Thermostat',
          currentState: 'on',
          plannedState: 'keep',
          // The producer emits the observational kind; the temperature card keys on
          // this, not on a resolved control model.
          deviceType: 'temperature',
          deviceClass: 'thermostat',
          // Observed device target 16 (see target_devices_snapshot), planner
          // moving it to the Home mode's 20 — same split as dev_heatpump.
          temperature: { currentTarget: 16, currentTemperature: 22.8, plannedTarget: 20 },
          priority: 3,
          controllable: true,
          available: true,
          expectedPowerKw: 0.5,
          currentDrawKw: 0,
          reason: { code: 'keep', detail: null },
          shedAction: 'set_temperature',
          shedTemperature: 15,
        },
        {
          id: 'dev_hallway',
          name: 'Hallway Thermostat',
          currentState: 'off',
          plannedState: 'keep',
          // The producer emits the observational kind; the temperature card keys on
          // this, not on a resolved control model.
          deviceType: 'temperature',
          deviceClass: 'thermostat',
          temperature: { currentTarget: 20, currentTemperature: 19.1, plannedTarget: 20 },
          priority: 3,
          controllable: true,
          available: true,
          expectedPowerKw: 0.8,
          currentDrawKw: 0,
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
          binaryControllable: true,
          deviceRole: 'ev_charger',
          evChargingState: 'plugged_in_charging',
          priority: 4,
          controllable: true,
          available: true,
          expectedPowerKw: 1.38,
          currentDrawKw: 1.38,
          actualStepId: '6a',
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
            selectedStepId: '6a',
            planningPowerKw: 1.38,
            commandPending: false,
          },
        },
        {
          id: 'dev_connected300',
          name: 'Connected 300',
          currentState: 'off',
          plannedState: 'keep',
          priority: 5,
          controllable: true,
          available: true,
          expectedPowerKw: 0.0,
          currentDrawKw: 0.0,
          temperature: { currentTarget: 65, currentTemperature: 51.1, plannedTarget: 65 },
          actualStepId: 'low',
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
              steps: [
                { id: 'low', planningPowerW: 750 },
                { id: 'medium', planningPowerW: 1500 },
                { id: 'high', planningPowerW: 2000 },
              ],
            },
            reportedStepId: 'low',
            targetStepId: 'low',
            selectedStepId: 'low',
            planningPowerKw: 0.0,
            commandPending: false,
          },
        },
        // dev_evcharger is deliberately ABSENT from the plan payload: the
        // fixture marks it unmanaged (managed_devices), and production never
        // plans an unmanaged device. Its detail page renders no hero
        // (liveStatus.ts hides the row when the plan carries no entry) — a
        // plan entry here once baked an unmanaged device "held back" into
        // every capture.
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

      // Producer-mirroring budget pace (PR-A): the daily budget spread by the
      // day's profile weights, ending exactly at the cap — the series the
      // Budget progress chart labels `Budget`. Without it the chart falls back
      // to the planned cumulative, whose terminal is NOT the budget.
      const totalWeight = plannedWeight.reduce((sum, w) => sum + w, 0);
      let cumWeight = 0;
      const budgetPaceCumKWh = plannedWeight.map((w) => {
        cumWeight += w;
        // Guard an all-zero weight profile: `cumWeight / 0` is NaN, which would
        // populate budgetPaceCumKWh with NaN and crash ECharts / fail asserts.
        const ratio = totalWeight > 0 ? cumWeight / totalWeight : 0;
        return Number((dailyBudgetKWh * ratio).toFixed(3));
      });

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
          budgetPaceCumKWh,
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
    // Goes into `target_devices_snapshot` — the DEVICE list, not the plan. That
    // shape still carries `controlModel` (it is the producer's own setting, read
    // by `getEffectiveControlModel`); only the plan snapshot retired it.
    controlModel: 'binary_power',
    name: 'Generic EV Charger',
    deviceClass: 'evcharger',
    deviceType: 'onoff',
    currentOn: false,
    binaryControllable: true,
    deviceRole: 'ev_charger',
    evChargingState: 'plugged_in_paused',
    measuredPowerKw: 0,
    expectedPowerKw: 7.2,
    expectedPowerSource: 'load-setting',
    capabilities: ['evcharger_charging', 'evcharger_charging_state'],
  };
  // Only injected for specs that flip the charger managed (see
  // ensureEvSupportState). Shaped like a production plan row: structured
  // reason (the runtime boundary rejects prose reasons) and the priority the
  // capacity_priorities map actually assigns this device.
  const evPlanDevice = {
    id: 'dev_evcharger',
    // Required on the plan snapshot: a binary load the owner sheds by turning off.
    name: 'Generic EV Charger',
    currentState: 'off',
    plannedState: 'shed',
    priority: 6,
    controllable: true,
    available: true,
    expectedPowerKw: 7.2,
    expectedPowerSource: 'load-setting',
    currentDrawKw: 0,
    reason: { code: 'capacity', shortfallKw: 5.8 },
    shedAction: 'turn_off',
  };

  const settings = {
    // Devices
    target_devices_snapshot: [
      {
        id: 'dev_heatpump',
        zone: 'Living room',
        zoneId: 'z_living',
        name: 'Living Room Heat Pump',
        deviceClass: 'heater',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 1.2,
        expectedPowerKw: 1.6,
        expectedPowerSource: 'measured-peak',
        targets: [{ name: 'target_temperature', value: 22 }],
      },
      {
        id: 'dev_floorheat',
        zone: 'Bathroom',
        zoneId: 'z_bath',
        name: 'Bathroom Floor Heat',
        deviceClass: 'heater',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 0.4,
        expectedPowerKw: 0.6,
        expectedPowerSource: 'homey-energy',
        targets: [{ name: 'target_temperature', value: 24 }],
      },
      {
        id: 'dev_waterheater',
        zone: 'Utility room',
        zoneId: 'z_utility',
        name: 'Water Heater',
        deviceClass: 'waterheater',
        measuredPowerKw: 2.1,
        expectedPowerKw: 2.0,
        expectedPowerSource: 'load-setting',
      },
      {
        id: 'dev_poolpump',
        zone: 'Garage',
        zoneId: 'z_garage',
        name: 'Pool Pump',
        deviceClass: 'socket',
        // Plain binary control handle: the fixture's "Run on solar surplus"
        // dump-load candidate (binary, no temperature target, not stepped, not
        // EV) — see the device-detail dump-load specs. A pool pump is a load
        // that can safely wait for the sun (unlike the water heater the copy
        // explicitly warns against).
        binaryControllable: true,
        capabilities: ['onoff'],
        measuredPowerKw: 0,
        expectedPowerKw: 1.0,
        expectedPowerSource: 'homey-energy',
      },
      {
        id: 'dev_bedroom',
        zone: 'Bedroom',
        zoneId: 'z_bedroom',
        name: 'Bedroom Thermostat',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 0,
        expectedPowerKw: 0.5,
        expectedPowerSource: 'default',
        currentTemperature: 20.8,
        targets: [{ name: 'target_temperature', value: 16 }],
      },
      {
        id: 'dev_hallway',
        zone: 'Hallway',
        zoneId: 'z_hallway',
        name: 'Hallway Thermostat',
        deviceClass: 'thermostat',
        deviceType: 'temperature',
        capabilities: ['onoff'],
        measuredPowerKw: 0,
        expectedPowerKw: 0.8,
        expectedPowerSource: 'default',
        currentTemperature: 19.1,
        targets: [{ name: 'target_temperature', value: 20 }],
      },
      {
        id: 'dev_zaptec',
        zone: 'Garage',
        zoneId: 'z_garage',
        name: 'Zaptec Go',
        deviceClass: 'evcharger',
        deviceType: 'onoff',
        controlModel: 'stepped_load',
        binaryControllable: true,
        deviceRole: 'ev_charger',
        evChargingState: 'plugged_in_charging',
        currentOn: true,
        measuredPowerKw: 1.38,
        expectedPowerKw: 1.38,
        expectedPowerSource: 'load-setting',
        capabilities: ['evcharger_charging', 'evcharger_charging_state'],
        steppedLoadProfile: {
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
        expectedPowerSource: 'default',
        capabilities: ['onoff'],
        steppedLoadProfile: {
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
      dev_poolpump: true,
      dev_evcharger: false,
      dev_bedroom: true,
      dev_hallway: true,
      dev_zaptec: true,
      dev_connected300: true,
    },
    budget_exempt_devices: {
      dev_waterheater: true,
    },
    temperature_control_disabled_devices: {},
    controllable_devices: {
      dev_heatpump: true,
      dev_floorheat: false,
      dev_waterheater: true,
      dev_poolpump: true,
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
        dev_poolpump: 2,
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
    pels_status: {
      lastPowerUpdate: Date.now() - 12 * 1000,
      // A current-hour price level exists whenever prices cover now (the
      // fixture ships combined_prices) — without it the Electricity-prices
      // "Right now" tier and the Settings-hub chip would honestly claim
      // "Awaiting prices" against a fixture that HAS prices.
      priceLevel: 'normal',
    },
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

    // In-memory plan snapshot
    plan_snapshot: buildSamplePlanSnapshot(),

    // Grid tariff settings
    nettleie_fylke: '03',
    nettleie_orgnr: '',
    nettleie_tariffgruppe: 'Husholdning',

    // Device control profiles (stepped load).
    //
    // These entries deliberately KEEP the retired `model: 'stepped_load'` tag:
    // this is a PERSISTED-SETTING fixture, and a real install upgraded from an
    // older build still has the tag in its stored map. Keeping it here exercises
    // the legacy-compatibility arm of `normalizeSteppedLoadProfile`, which accepts
    // an absent or `'stepped_load'` tag and strips it. Do NOT copy the tag onto
    // runtime snapshot fixtures — `SteppedLoadProfile` has no such field, and a
    // snapshot carrying it would let UI code read `profile.model` in E2E while
    // failing against real payloads.
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

    // Hidden weather-insight flag. Absent/disabled by default so every other
    // spec exercises the structural-absence path; weather specs flip it via
    // `__PELS_HOMEY_STUB__ = { settings: { weather_advisor_settings: {...} } }`.
    weather_advisor_settings: undefined,
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
    // Only a MANAGED charger may appear in the plan: production never plans
    // an unmanaged device, and its detail page proves it by rendering no
    // hero. Explicit `=== true`, matching the UI's own managed resolver
    // (state.ts): a sparse scenario map without the key means unmanaged,
    // and injecting a plan row for it would fabricate the exact hero this
    // gate exists to prevent.
    if (!hasEvPlanDevice && settings.managed_devices?.[evPlanDevice.id] === true) {
      settings.plan_snapshot = {
        ...settings.plan_snapshot,
        devices: [...(settings.plan_snapshot?.devices ?? []), { ...evPlanDevice }],
      };
    }
  };

  ensureEvSupportState();
  // Mirror the runtime snapshot producer: availability is resolved before the
  // device list crosses the Homey API bridge, so every inward snapshot carries
  // an explicit boolean. Preserve scenario-specific false values.
  settings.target_devices_snapshot = settings.target_devices_snapshot.map((device) => ({
    available: true,
    ...device,
  }));

  // Mirror the runtime producer (`lib/price/exportPrice.ts` applyExportPrices):
  // when export pricing is enabled, each hour gains an incl-VAT export price =
  // (spotPriceExVat × vatMultiplier) × export_spot_factor/100 + export_fixed.
  // A spot-linked config (factor ≠ 0) on an hour without an isolatable spot
  // yields NO export price — exactly as production. Runs after the settings
  // merge so tests enable it via `__PELS_HOMEY_STUB__.settings`.
  const applyExportPricesToCombined = () => {
    if (settings.export_price_enabled !== true) return;
    const combined = settings.combined_prices;
    if (!combined || !Array.isArray(combined.prices)) return;
    const factor = (Number.isFinite(settings.export_spot_factor) ? settings.export_spot_factor : 0) / 100;
    const fixed = Number.isFinite(settings.export_fixed) ? settings.export_fixed : 0;
    combined.prices.forEach((entry) => {
      if (factor !== 0 && !Number.isFinite(entry.spotPriceExVat)) return;
      const spotInclVat = (Number.isFinite(entry.spotPriceExVat) ? entry.spotPriceExVat : 0)
        * (Number.isFinite(entry.vatMultiplier) ? entry.vatMultiplier : 1);
      entry.exportPrice = spotInclVat * factor + fixed;
    });
  };

  applyExportPricesToCombined();

  // Mirrors the real read-boundary classification (`classifyMainPowerStatus`
  // and the scoped composer, setup/settingsUiApi.ts): a tracker with no
  // `lastPowerW` latch is a home whose measurement gate is shut, and its
  // persisted `pels_status` blob is NEVER served as live — the union arm says
  // why instead. Keep in sync with the producer.
  const classifyPowerStatus = (tracker, statusBlob) => {
    const lastPowerW = tracker && typeof tracker === 'object' ? tracker.lastPowerW : undefined;
    if (typeof lastPowerW !== 'number' || !Number.isFinite(lastPowerW)) {
      return { state: 'unavailable', reason: 'no_measurement' };
    }
    return statusBlob && typeof statusBlob === 'object' && !Array.isArray(statusBlob)
      ? { state: 'live', status: statusBlob }
      : { state: 'unavailable', reason: 'no_status_recorded' };
  };

  const buildPowerPayload = () => {
    // Branch on `!== undefined` (not `?? baseline`) so a scenario can force a
    // null power payload to exercise the "power feed missing" UI state.
    const scenarioPatch = runtimeOverrides.scenarioPatch;
    if (scenarioPatch && Object.prototype.hasOwnProperty.call(scenarioPatch, 'power')) {
      return scenarioPatch.power;
    }
    return {
      tracker: settings.power_tracker_state ?? null,
      status: classifyPowerStatus(settings.power_tracker_state, settings.pels_status),
      heartbeat: typeof settings.app_heartbeat === 'number' ? settings.app_heartbeat : null,
      // Mirrors the real producer (setup/settingsUiApi.ts getSettingsUiPower):
      // a solarpanel device in the snapshot AND the homey_energy power source
      // (unset normalizes to flow, which has no solar signal — see
      // lib/power/powerSource.ts). The default fixture has neither, so the
      // Usage Solar card stays hidden across the suite — the /ui_devices
      // handler's hardcoded `hasManagedSolarDevice: true` is a separate
      // fixture lie kept alive solely for the device-detail surplus spec.
      hasManagedSolarDevice: settings.power_source === 'homey_energy'
        && settings.target_devices_snapshot
          .some((device) => device.deviceClass === 'solarpanel'),
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
    // Runtime provenance of the PV-forecast source selection (mirrors
    // getSettingsUiPrices). Seed `pv_forecast_source_status` in a scenario to
    // render the Solar forecast provenance line; the default `unknown` is the
    // pre-wiring boot window.
    pvForecastSource: settings.pv_forecast_source_status ?? { kind: 'unknown' },
  });

  const buildPlanPayload = () => {
    // Branch on `hasOwnProperty` so a scenario can force a null plan (used to
    // exercise the "no plan yet" UI state); `?? baseline` would mask that.
    const scenarioPatch = runtimeOverrides.scenarioPatch;
    if (scenarioPatch && Object.prototype.hasOwnProperty.call(scenarioPatch, 'plan')) {
      return scenarioPatch.plan;
    }
    // Test knob: `settings.plan_snapshot_meta_patch` merges into the sample
    // plan's meta so a spec can make the hero numerically consistent with an
    // overridden tracker (e.g. an exporting home needs a negative net
    // `totalKw`) without replicating the whole plan fixture.
    const metaPatch = settings.plan_snapshot_meta_patch;
    if (metaPatch && typeof metaPatch === 'object' && settings.plan_snapshot?.meta) {
      return { ...settings.plan_snapshot, meta: { ...settings.plan_snapshot.meta, ...metaPatch } };
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

  // The daily-budget endpoints answer the host API's discriminated read
  // (`DailyBudgetUiRead`). The payload builders above stay payload-shaped so
  // scenario patches and `__stub.setDailyBudgetPayload` keep working; the wrap
  // happens once here, mirroring the producer.
  const resolveDailyBudgetRead = () => {
    const payload = resolveDailyBudgetPayload();
    return payload ? { kind: 'budget', payload } : { kind: 'unavailable' };
  };

  // Mirror the real API producer (`app.ts getDeferredObjectiveActivePlansUiPayload`
  // → `setup/deferredObjectiveActivePlansUiAssembler` → `toResolvedActivePlans`):
  // the settings UI receives active plans with the kind-split (°C/%) target,
  // start-progress, and per-sample value pairs already resolved to flat fields.
  // Fixtures (sample + scenario patches) inject raw plans, so resolve them here.
  // Idempotent (nullish-keeps an already-resolved value); leftover raw columns are
  // harmless — the UI reads only the resolved fields.
  const toResolvedActivePlan = (plan) => ({
    ...plan,
    targetValue: plan.targetValue ?? plan.targetPercent ?? plan.targetTemperatureC ?? null,
    ...(plan.startProgressC !== undefined
      || plan.startProgressPercent !== undefined
      || plan.startProgressValue !== undefined
      ? { startProgressValue: plan.startProgressValue ?? plan.startProgressPercent ?? plan.startProgressC ?? null }
      : {}),
    ...(Array.isArray(plan.progressSamples)
      ? {
        progressSamples: plan.progressSamples.map((sample) => ({
          ...sample,
          value: sample.value ?? sample.valuePercent ?? sample.valueC ?? null,
        })),
      }
      : {}),
  });

  const resolveActivePlans = (payload) => {
    if (!payload || typeof payload !== 'object' || !payload.plansByDeviceId) return payload;
    const plansByDeviceId = {};
    for (const [deviceId, plan] of Object.entries(payload.plansByDeviceId)) {
      plansByDeviceId[deviceId] = plan && typeof plan === 'object' ? toResolvedActivePlan(plan) : plan;
    }
    return { ...payload, plansByDeviceId };
  };

  const resolveActivePlansPayload = () => {
    const scenarioPlans = runtimeOverrides.scenarioPatch?.deferredObjectiveActivePlans;
    if (scenarioPlans !== undefined) return resolveActivePlans(scenarioPlans);
    return resolveActivePlans(buildSampleActivePlans());
  };

  // Mirror the real API producer (`setup/appSmartTaskPayloads.ts buildPlanHistoryUiPayload` →
  // `toResolvedPlanHistoryEntry`): the settings UI receives plan-history entries
  // with the kind-split (°C/%) pairs already resolved to flat `*Value` fields.
  // Fixtures inject raw entries, so resolve them here. Idempotent (nullish-keeps
  // a value the fixture already resolved); raw columns left on the object are
  // harmless — the UI reads only the resolved fields.
  const toResolvedHistoryEntry = (entry) => ({
    ...entry,
    targetValue: entry.targetValue ?? entry.targetPercent ?? entry.targetTemperatureC ?? null,
    startProgressValue: entry.startProgressValue ?? entry.startProgressPercent ?? entry.startProgressC ?? null,
    finalProgressValue: entry.finalProgressValue ?? entry.finalProgressPercent ?? entry.finalProgressC ?? null,
    ...(Array.isArray(entry.progressSamples)
      ? {
        progressSamples: entry.progressSamples.map((sample) => ({
          ...sample,
          value: sample.value ?? sample.valuePercent ?? sample.valueC ?? null,
        })),
      }
      : {}),
  });

  const resolveHistoryEntries = (payload) => {
    if (!payload || typeof payload !== 'object' || !payload.entriesByDeviceId) return payload;
    const entriesByDeviceId = {};
    for (const [deviceId, list] of Object.entries(payload.entriesByDeviceId)) {
      entriesByDeviceId[deviceId] = Array.isArray(list) ? list.map(toResolvedHistoryEntry) : list;
    }
    return { ...payload, entriesByDeviceId };
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

  const resolveDeviceLogPayload = () => {
    const scenarioDeviceLog = runtimeOverrides.scenarioPatch?.deviceLog;
    if (scenarioDeviceLog !== undefined) return scenarioDeviceLog;
    return { version: 1, entriesByDeviceId: {} };
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
      if (Array.isArray(buckets.budgetPaceCumKWh)) {
        buckets.budgetPaceCumKWh = buckets.budgetPaceCumKWh.map((v) => Number(((v ?? 0) * ratio).toFixed(3)));
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

  // Danger-state knob: `window.__PELS_HOMEY_STUB__ = { deadlinePlanUnderBooked:
  // true }` serves an under-booked active plan (booked kWh < energyNeededKWh)
  // so the trajectory card's data-driven cannot-finish branch (staircase tops
  // out short of the target) is reachable from a Playwright harness. The
  // baseline plan always books exactly what it needs, which keeps that branch
  // dead in every other spec.
  const deadlinePlanUnderBooked = initialOverrides.deadlinePlanUnderBooked === true;
  // Scope-state knob: stamp the sample smart task with the runtime diagnostic
  // emitted when its device moves to a separate meter. The detail surface must
  // then suppress editing while retaining the clear action.
  const deadlinePlanSeparateMeter = initialOverrides.deadlinePlanSeparateMeter === true;

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
      // Under-booked scenario: needs 35 kWh but only books `plannedHourCount
      // × 2` (12 kWh at the default 8-hour deadline), so the projected
      // staircase tops out short of the target and the danger stateline +
      // red deadline render.
      energyNeededKWh: deadlinePlanUnderBooked ? 35 : plannedHourCount * 2,
      planStatus: deadlinePlanUnderBooked ? 'cannot_meet' : 'on_track',
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
          ...(deadlinePlanSeparateMeter
            ? { diagnosticReasonCode: 'objective_device_in_sub_home' }
            : {}),
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
    export_price_enabled: settings.export_price_enabled,
    export_spot_factor: settings.export_spot_factor,
    export_fixed: settings.export_fixed,
    daily_budget_enabled: settings.daily_budget_enabled,
    daily_budget_kwh: settings.daily_budget_kwh,
    daily_budget_price_shaping_enabled: settings.daily_budget_price_shaping_enabled,
    daily_budget_controlled_weight: settings.daily_budget_controlled_weight,
    daily_budget_price_flex_share: settings.daily_budget_price_flex_share,
    debug_logging_topics: settings.debug_logging_topics,
    debug_logging_enabled: settings.debug_logging_enabled,
    overview_redesign_enabled: settings.overview_redesign_enabled,
    device_control_profiles: settings.device_control_profiles,
    deferred_objectives: settings.deferred_objectives,
    weather_advisor_settings: settings.weather_advisor_settings,
  });

  // Sample weather-insight readout, mirroring the real producer
  // (`lib/weather/weatherAdvisorReadout.ts` buildWeatherAdvisorReadout): the
  // payload arrives fully resolved — state enum, decimated 1 °C scatter bins,
  // 5 °C coverage bins, tomorrow prediction/suggestion — so the UI never
  // re-derives from raw records. Tests pin alternate states via
  // `__PELS_HOMEY_STUB__.weatherReadout` or a per-test apiHandlers override.
  const buildWeatherReadoutPayload = () => {
    if (runtimeOverrides.weatherReadout !== undefined) return runtimeOverrides.weatherReadout;
    const advisor = settings.weather_advisor_settings;
    if (!advisor || advisor.enabled !== true) return null;
    const nowMs = Date.now();
    const settingsEcho = {
      outdoorDeviceId: advisor.outdoorDeviceId ?? null,
      outdoorDeviceName: advisor.outdoorDeviceId ? 'Outdoor sensor' : null,
    };
    // The forecast comes from a direct MET Norway fetch (not a device), so the
    // ready payload always reports `forecast` (met_api); persistence fallback
    // would be `recent_days`. Tests pin recent_days via runtimeOverrides.
    // Normalise to the contracted union so an override can only pin a valid value.
    const forecastStatus = advisor.forecastStatus === 'recent_days' ? 'recent_days' : 'forecast';
    const outdoorReading = advisor.outdoorDeviceId
      ? { status: 'reading', tempC: 4 }
      : { status: 'no_device' };
    // Mirrors the producer's resolveDailyBudgetKwh: enabled AND a positive number,
    // else null (a 0/negative budget is "no budget", not a literal 0).
    const budgetValue = Number(settings.daily_budget_kwh ?? 0);
    const dailyBudgetKwh = settings.daily_budget_enabled !== false && budgetValue > 0
      ? budgetValue
      : null;
    // Mirror the producer's payload echoes: dailyBudgetEnabled gates the auto-apply
    // inert hint (=== true), autoApply + lastAutoApply come from the config/state.
    const dailyBudgetEnabled = settings.daily_budget_enabled === true;
    const autoApplyDailyBudget = advisor.autoApplyDailyBudget === true;
    const lastAutoApply = advisor.lastAutoApply ?? null;
    const emptyPayload = (state) => ({
      state,
      driftSuspected: false,
      driftDeviationKwh: null,
      settings: settingsEcho,
      forecastStatus,
      outdoorReading,
      dailyBudgetKwh,
      dailyBudgetEnabled,
      autoApplyDailyBudget,
      lastAutoApply,
      fit: null,
      coverage: [],
      prediction: null,
      suggestion: null,
      scatter: [],
      recentDays: [],
      yesterday: null,
      usableDays: 0,
      backfilledDays: 0,
      suppressedDaysExcluded: 0,
      generatedAtMs: nowMs,
    });
    if (!advisor.outdoorDeviceId) return emptyPayload('needs_device');

    const balanceC = 13;
    const baseLoad = 23;
    const slope = 1.8;
    const typicalKwh = (tempC) => baseLoad + slope * Math.max(0, balanceC - tempC);
    const scatter = [];
    for (let t = -12; t <= 24; t += 1) {
      const median = typicalKwh(t);
      const count = Math.max(2, 14 - Math.abs(t - 5));
      scatter.push({
        tempBinC: t,
        kwhMedian: Number(median.toFixed(1)),
        kwhQ1: Number((median - 3).toFixed(1)),
        kwhQ3: Number((median + 3).toFixed(1)),
        count,
      });
    }
    const recentDays = [];
    for (let i = 30; i >= 1; i -= 1) {
      const tempC = 2 + 8 * Math.sin(i / 4);
      const kwh = typicalKwh(tempC) + (i % 7) - 3;
      recentDays.push({
        dateKey: dateKeyUtc(nowMs - i * 24 * 3600 * 1000),
        tempMeanC: Number(tempC.toFixed(1)),
        kwhTotal: Number(Math.max(8, kwh).toFixed(1)),
        quality: {
          partialTemp: i === 9,
          missingKwh: false,
          unreliablePower: false,
          backfilled: false,
        },
      });
    }
    const yesterdayDay = recentDays[recentDays.length - 1];
    const coverage = [];
    for (let fromC = -15; fromC < 25; fromC += 5) {
      const days = fromC < -10 || fromC >= 20 ? 3 : (fromC < -5 ? 9 : 40);
      coverage.push({ fromC, toC: fromC + 5, days, sufficient: days >= 14 });
    }
    const predictedKwh = typicalKwh(2);
    return {
      state: 'ready',
      driftSuspected: false,
      driftDeviationKwh: null,
      settings: settingsEcho,
      forecastStatus,
      outdoorReading,
      dailyBudgetKwh,
      dailyBudgetEnabled,
      autoApplyDailyBudget,
      lastAutoApply,
      fit: {
        model: 'changepoint',
        baseLoadKwhPerDay: baseLoad,
        slopeKwhPerDegree: slope,
        slopeCiLow: 1.5,
        slopeCiHigh: 2.1,
        balancePointC: balanceC,
        pseudoR2: 0.78,
        usableDays: 287,
        observedTempMinC: -12,
        observedTempMaxC: 24,
        medianDayKwh: 38,
        lowObservedDayKwh: 18,
        confidence: 'high',
        curvatureSteeperWhenCold: false,
        heatLossWPerK: 75,
        driftSuspected: false,
        suppressedDaysExcluded: 0,
        suppressionFilterRelaxed: false,
        recentSuppressionSuspected: false,
        residualQ10: -5,
        residualQ50: 0,
        residualQ80: 5,
        residualQ90: 7,
        fittedAtMs: nowMs,
      },
      coverage,
      prediction: {
        tempMeanC: 2,
        // Producer-resolved tomorrow low/high from the MET day summary.
        tempMinC: -4,
        tempMaxC: 6,
        kwh: Number(predictedKwh.toFixed(1)),
        lowKwh: Number((predictedKwh - 5).toFixed(1)),
        highKwh: Number((predictedKwh + 7).toFixed(1)),
        beyondObservedCold: false,
        beyondObservedWarm: false,
      },
      suggestion: {
        kwh: Number((predictedKwh + 5).toFixed(1)),
        currentDailyBudgetKwh: settings.daily_budget_enabled !== false
          ? Number(settings.daily_budget_kwh ?? 0)
          : null,
        cappedByCapacity: advisor.cappedByCapacity === true,
        budgetMayBeLimiting: advisor.budgetMayBeLimiting === true,
        budgetPressureKwh: Number(advisor.budgetPressureKwh ?? 0),
      },
      scatter,
      recentDays,
      yesterday: {
        dateKey: yesterdayDay.dateKey,
        tempMeanC: yesterdayDay.tempMeanC,
        kwhTotal: yesterdayDay.kwhTotal,
        deviationKwh: 1.2,
      },
      usableDays: 287,
      backfilledDays: 240,
      suppressedDaysExcluded: 0,
      generatedAtMs: nowMs,
    };
  };

  // Multi-home fixtures (the R4 read-only `ui_homes` endpoint). The zone
  // forest matches the `zone`/`zoneId` fields on `target_devices_snapshot`;
  // the rental subtree exists so the "Multiple meters" specs can seed an area
  // there. Membership mirrors the producer's rule of record (`resolveDeviceHome`,
  // lib/home/membership.ts): an explicit pin in `device_home_assignments`
  // overrides the zone rule, otherwise a device belongs to the first configured
  // area whose root zone sits on its zone's ancestor path, else the main home.
  // Composed from live `settings.homes_config` so a settings write from the
  // create/edit/delete flows round-trips into the next `ui_homes` fetch like
  // the real endpoint.
  const HOMES_ZONE_TREE = {
    z_home: { id: 'z_home', name: 'Home', parent: null },
    z_living: { id: 'z_living', name: 'Living room', parent: 'z_home' },
    z_bath: { id: 'z_bath', name: 'Bathroom', parent: 'z_home' },
    z_bedroom: { id: 'z_bedroom', name: 'Bedroom', parent: 'z_home' },
    z_hallway: { id: 'z_hallway', name: 'Hallway', parent: 'z_home' },
    z_utility: { id: 'z_utility', name: 'Utility room', parent: 'z_home' },
    z_garage: { id: 'z_garage', name: 'Garage', parent: 'z_home' },
    z_rental: { id: 'z_rental', name: 'Rental unit', parent: 'z_home' },
    z_rental_living: { id: 'z_rental_living', name: 'Rental living room', parent: 'z_rental' },
    z_rental_utility: { id: 'z_rental_utility', name: 'Rental utility', parent: 'z_rental' },
  };

  const buildHomesPayload = () => {
    const raw = settings.homes_config;
    const subHomes = raw && Array.isArray(raw.subHomes) ? raw.subHomes : [];
    const zonePath = (zoneId) => {
      const path = [];
      let current = zoneId;
      while (current && HOMES_ZONE_TREE[current] && !path.includes(current)) {
        path.push(current);
        current = HOMES_ZONE_TREE[current].parent;
      }
      return path;
    };
    // Mirror of `resolveDeviceHome` (lib/home/membership.ts): an explicit pin
    // overrides the zone rule — a pin to a rostered area or to 'main' wins
    // (pinning to 'main' opts a device out of a surrounding area), while a
    // dangling pin (nonexistent homeId) falls back to the zone rule, visibly
    // as `source: 'fallback'`. No pin → the zone rule, `source: 'zone'`.
    const rawPins = settings.device_home_assignments;
    const pins = rawPins && typeof rawPins === 'object' && !Array.isArray(rawPins) ? rawPins : {};
    const membershipByDeviceId = {};
    (settings.target_devices_snapshot || []).forEach((device) => {
      const pin = Object.prototype.hasOwnProperty.call(pins, device.id) ? pins[device.id] : undefined;
      if (pin === 'main' || subHomes.some((home) => home.homeId === pin)) {
        membershipByDeviceId[device.id] = { homeId: pin, source: 'pin' };
        return;
      }
      if (!device.zoneId) return;
      const path = zonePath(device.zoneId);
      const owner = subHomes.find((home) => path.includes(home.rootZoneId));
      membershipByDeviceId[device.id] = {
        homeId: owner ? owner.homeId : 'main',
        source: pin === undefined ? 'zone' : 'fallback',
      };
    });
    return {
      homes: subHomes,
      membershipByDeviceId,
      zoneTree: HOMES_ZONE_TREE,
      hasSubHomes: subHomes.length > 0,
      runtimeActive: subHomes.length === 0
        || raw?.activationVersion === 1
        || settings.multi_home_enabled === true,
      // Healthy stub default; degraded specs override the whole handler.
      configDegraded: false,
    };
  };

  // Producer mirror of the runtime's intent-op save endpoint: apply the one
  // op to the persisted settings blob (create allocates an `h_` + 8-hex id),
  // so the UI's save → refetch round-trip behaves like production.
  // The area name/count rules the runtime also enforces (non-empty, unique,
  // length- and count-capped, "Main home" reserved) are deliberately NOT
  // re-spelled here: their constants live in TypeScript shared-domain, this
  // fixture cannot import them, and a hand-copied cap would drift silently.
  // They are covered by test/integration/homeMembershipService.test.ts. The
  // whole-home meter requirement below is structural, so it does mirror.
  const applyHomesSaveOp = (body) => {
    const raw = settings.homes_config;
    const current = raw && Array.isArray(raw.subHomes) ? raw.subHomes : [];
    if (!body || typeof body !== 'object') return { ok: false, reason: 'invalid' };
    if (body.op === 'set_power_source') {
      if (body.source !== 'homey_energy' && body.source !== 'flow') {
        return { ok: false, reason: 'invalid' };
      }
      if (body.source === 'flow') {
        // Flow and RUNNING meter areas are mutually exclusive. Same activation
        // term as production; a dormant pre-GA config never blocks the switch.
        const areasRunning = current.length > 0
          && (raw?.activationVersion === 1 || settings.multi_home_enabled === true);
        if (areasRunning) {
          return { ok: false, reason: 'homey_energy_required' };
        }
        settings.power_source = 'flow';
        return { ok: true };
      }
      // Homey Energy carries the meter it will read (the atomic pair — there
      // is no set_main_meter op and no Automatic): meter key first, source
      // only when it is not already homey_energy, mirroring the producer.
      const meterDeviceId = typeof body.meterDeviceId === 'string' ? body.meterDeviceId.trim() : '';
      if (meterDeviceId.length === 0) {
        return { ok: false, reason: 'invalid' };
      }
      const collision = current.find((area) => area.meterDeviceId === meterDeviceId);
      if (collision) {
        return { ok: false, reason: 'meter_in_use', otherName: collision.name };
      }
      settings.homey_energy_meter_device_id = meterDeviceId;
      if (settings.power_source !== 'homey_energy') {
        settings.power_source = 'homey_energy';
      }
      return { ok: true };
    }
    if (body.op === 'delete') {
      settings.homes_config = {
        ...(raw?.activationVersion === 1 ? { activationVersion: 1 } : {}),
        subHomes: current.filter((area) => area.homeId !== body.homeId),
      };
      return { ok: true };
    }
    if (body.op !== 'upsert' || !body.area || typeof body.area !== 'object') {
      return { ok: false, reason: 'invalid' };
    }
    const requested = body.area;
    if (HOMES_ZONE_TREE[requested.rootZoneId] && HOMES_ZONE_TREE[requested.rootZoneId].parent === null) {
      return { ok: false, reason: 'invalid' };
    }
    // The other direction of the same exclusion, structural like the meter
    // requirement below: no area save on the Flow (or unset, which the
    // runtime resolves to Flow) power source.
    if (settings.power_source !== 'homey_energy') {
      return { ok: false, reason: 'homey_energy_required' };
    }
    // On the Homey Energy source the Main home must name its own meter before
    // an area can exist.
    if ((settings.homey_energy_meter_device_id ?? null) === null) {
      return { ok: false, reason: 'main_meter_required' };
    }
    const homeId = requested.homeId
      ?? `h_${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
    const entry = {
      homeId, name: requested.name, rootZoneId: requested.rootZoneId, meterDeviceId: requested.meterDeviceId,
    };
    const exists = current.some((area) => area.homeId === homeId);
    settings.homes_config = {
      activationVersion: 1,
      subHomes: exists
        ? current.map((area) => (area.homeId === homeId ? entry : area))
        : [...current, entry],
    };
    return { ok: true };
  };

  // Mirror the producer's `?homeId=` contract (`setup/settingsUiHomeScope.ts` +
  // the composers in `setup/settingsUiApi.ts`):
  //
  // - no `homeId`  → the historical payload, with NO `homeScope` member, so the
  //   whole-home response stays byte-identical (this is what every existing spec
  //   asserts against, and what a single-home install always gets);
  // - a live meter area → THAT AREA'S data (its suffixed fixtures, its member
  //   devices), never the whole home's payload wearing a sub-home badge — a
  //   spec written against this stub must not pass on another home's values;
  // - anything else — a refused id, an unknown area, or a rostered area whose
  //   runtime is not active → the EMPTY shape plus an `unavailable` scope. The
  //   refused ids need no hand-copied character rules here: they are never in
  //   the roster, so the membership check alone classifies them identically.
  const resolveServableHomeId = (query) => {
    const homeId = query?.homeId;
    if (homeId === undefined) return { scoped: false };
    const isServable = typeof homeId === 'string'
      && (settings.homes_config?.subHomes ?? []).some((home) => home.homeId === homeId)
      // The producer serves only a WIRED bundle; the stub's activation bit is
      // the closest seam (`buildHomesPayload` derives it the same way).
      && buildHomesPayload().runtimeActive;
    return { scoped: true, homeId: isServable ? homeId : null };
  };

  // One sub-home's member devices, via the same pin-over-zone membership
  // `buildHomesPayload` computes — the stub's one attribution source.
  const devicesForHome = (homeId) => {
    const membership = buildHomesPayload().membershipByDeviceId;
    return (settings.target_devices_snapshot || [])
      .filter((device) => membership[device.id]?.homeId === homeId);
  };

  const scopedPlanHandler = (query, wholeHomePayload) => {
    const scope = resolveServableHomeId(query);
    if (!scope.scoped) return wholeHomePayload;
    if (scope.homeId === null) return { plan: null, homeScope: { state: 'unavailable' } };
    // The area's OWN committed-plan fixture (`plan_snapshot:<homeId>`, the
    // same suffix convention as its `pels_status:<homeId>` status blob; in
    // production the runtime serves this from the bundle's memory, not a
    // setting). Absence is the honest pre-first-commit `null` — never Main's
    // plan under an area badge.
    return {
      plan: settings[`plan_snapshot:${scope.homeId}`] ?? null,
      homeScope: { state: 'resolved', homeId: scope.homeId },
    };
  };

  const scopedPowerHandler = (query, wholeHomePayload) => {
    const scope = resolveServableHomeId(query);
    if (!scope.scoped) return wholeHomePayload;
    if (scope.homeId === null) {
      return { tracker: null, status: null, heartbeat: null, homeScope: { state: 'unavailable' } };
    }
    return {
      // The area's OWN suffixed fixtures — absence is honest "not committed
      // yet", never main's tracker/status under an area badge.
      tracker: settings[`power_tracker_state:${scope.homeId}`] ?? null,
      status: classifyPowerStatus(
        settings[`power_tracker_state:${scope.homeId}`],
        settings[`pels_status:${scope.homeId}`],
      ),
      heartbeat: null,
      // Same source gate as `buildPowerPayload` above, because the scoped
      // producer (`powerPayloadForHome`) applies it too: `readPowerSource()`
      // reads the GLOBAL `power_source` key, and only `homey_energy` yields
      // the flag. Ungated, a Flow-source scenario with a `solarpanel` member
      // would let a scoped Usage spec validate a Solar card production hides.
      hasManagedSolarDevice: settings.power_source === 'homey_energy'
        && devicesForHome(scope.homeId).some((device) => device.deviceClass === 'solarpanel'),
      homeScope: { state: 'resolved', homeId: scope.homeId },
    };
  };

  // Mirror of `OBSERVE_ONLY_ROLE_CLASS_KEYS` in
  // `packages/shared-domain/src/observeOnlyRole.ts` — the stub is injected into
  // the WebView as a plain script and cannot import it. Keep the two in sync.
  const OBSERVE_ONLY_ROLE_CLASS_KEYS = new Set(['battery', 'solarpanel']);

  const scopedDevicesHandler = (query, wholeHomePayload) => {
    const scope = resolveServableHomeId(query);
    if (!scope.scoped) return wholeHomePayload;
    if (scope.homeId === null) return { devices: [], homeScope: { state: 'unavailable' } };
    const members = devicesForHome(scope.homeId);
    return {
      // The real producer (`devicesPayloadForHome`, setup/settingsUiApi.ts)
      // removes every observe-only role member from the user-facing list while
      // computing the solar flag from the UNFILTERED member set — mirror both,
      // or scoped specs would render management controls production never offers.
      devices: members.filter((device) => !OBSERVE_ONLY_ROLE_CLASS_KEYS.has(device.deviceClass)),
      hasManagedSolarDevice: members.some((device) => device.deviceClass === 'solarpanel'),
      // A sub-meter has its own export accounting; default false, per-area
      // override when a spec seeds it.
      hasExhibitedExport: settings[`ui_devices_has_exhibited_export:${scope.homeId}`] ?? false,
      // Hardcoded false in the producer for ANY sub-home: its bundle binds
      // `getInferredSurplusKw: () => null`, is fenced out of the posture, and
      // gets empty price-opt settings, so neither surplus modality can act.
      surplusPoolReachable: false,
      homeScope: { state: 'resolved', homeId: scope.homeId },
    };
  };

  const apiHandlers = {
    'GET /daily_budget': () => resolveDailyBudgetRead(),
    'GET /ui_homes': () => buildHomesPayload(),
    'POST /ui_homes_save': (body) => applyHomesSaveOp(body),
    'GET /homey_devices': () => {
      // Used by advanced device logger/cleanup, the Weather insight pickers
      // (which filter on hasTemperature), and the whole-home meter picker
      // (which filters on hasPower + class 'sensor'). Mirrors the api.ts
      // homey_devices shape.
      return [
        { id: 'dev_outdoor', name: 'Outdoor sensor', class: 'sensor', hasTemperature: true, hasPower: false },
        { id: 'dev_han', name: 'HAN power meter', class: 'sensor', hasTemperature: false, hasPower: true },
        { id: 'dev_heatpump', name: 'Living Room Heat Pump', class: 'thermostat', hasTemperature: true, hasPower: true },
        { id: 'dev_floorheat', name: 'Bathroom Floor Heat', class: 'thermostat', hasTemperature: true, hasPower: true },
        { id: 'dev_waterheater', name: 'Water Heater', class: 'heater', hasTemperature: false, hasPower: true },
        { id: 'dev_evcharger', name: 'Generic EV Charger', class: 'evcharger', hasTemperature: false, hasPower: true },
      ];
    },
    'GET /homey_energy_meters': () => {
      // Backs both whole-home meter pickers: the meters the endpoint resolved
      // from the Homey Energy report (whole-home cumulative + sensor-class
      // device meters), already narrowed to real meters — NOT appliances.
      // Mirrors the api.ts homey_energy_meters {id,name} shape. The fixture home
      // reports a single whole-home HAN meter.
      return [
        { id: 'dev_han', name: 'HAN power meter' },
      ];
    },
    'GET /ui_bootstrap': () => ({
      settings: buildBootstrapSettings(),
      dailyBudget: resolveDailyBudgetRead(),
      deferredObjectiveActivePlans: resolveActivePlansPayload(),
      devices: settings.target_devices_snapshot,
      plan: buildPlanPayload(),
      power: buildPowerPayload(),
      prices: buildPricesPayload(),
    }),
    'GET /ui_devices': (_body, query) => scopedDevicesHandler(query, {
      devices: settings.target_devices_snapshot,
      // This fixture home has a tracked solar/PV device by default, so the per-device
      // "Use solar surplus" control is offered (see device-detail.spec surplus test).
      // Both solar signals are overridable via settings so a spec can seed the
      // meter-only PV case (no tracked device, but exhibited grid export).
      hasManagedSolarDevice: settings.ui_devices_has_managed_solar ?? true,
      hasExhibitedExport: settings.ui_devices_has_exhibited_export ?? false,
      // Whether the surplus ENGINE can act — a strictly narrower question than
      // having solar, and the one that gates the "Use solar surplus" control
      // (`resolveSurplusPoolReachable`). This fixture home exports, so it is
      // true by default; a spec seeds false for the home that has panels but
      // whose whole-home net never goes negative.
      surplusPoolReachable: settings.ui_devices_surplus_pool_reachable ?? true,
    }),
    'GET /ui_plan': (_body, query) => scopedPlanHandler(query, {
      plan: buildPlanPayload(),
    }),
    'GET /ui_power': (_body, query) => scopedPowerHandler(query, buildPowerPayload()),
    'GET /ui_prices': () => buildPricesPayload(),
    'GET /ui_device_diagnostics': () => resolveDeviceDiagnosticsPayload(),
    'GET /ui_device_log': () => resolveDeviceLogPayload(),
    'GET /ui_deferred_objective_history': () => resolveDeferredObjectiveHistoryPayload(),
    // Objectives moved to per-device keys; the UI's loadDeferredObjectiveSettings
    // now reads this endpoint (the legacy blob is consumed by the migration). The
    // stub doesn't model per-key storage, so serve the same assembled map the
    // bootstrap exposes.
    'GET /ui_deferred_objective_settings': () => (
      settings.deferred_objectives ?? { version: 1, objectivesByDeviceId: {} }
    ),
    // The overview boots a rescuable-device fetch (the "Let it run now" chip gate).
    // Serve an empty set so the call resolves cleanly — no chip in the default e2e
    // state, and no unhandled-key error noise from the dispatch chokepoint.
    'GET /ui_starvation_rescue_devices': () => ({ rescuableDeviceIds: [] }),
    'GET /ui_weather_advisor_readout': () => {
      // `inactive` = the feature is off; the producer's structural-absence member.
      const payload = buildWeatherReadoutPayload();
      return payload ? { kind: 'readout', payload } : { kind: 'inactive' };
    },
    'POST /settings_ui_log': () => ({ ok: true }),
    'POST /log_homey_device': () => ({ ok: true }),
    'POST /ui_refresh_devices': () => ({
      devices: settings.target_devices_snapshot,
      hasManagedSolarDevice: settings.ui_devices_has_managed_solar ?? true,
      hasExhibitedExport: settings.ui_devices_has_exhibited_export ?? false,
      surplusPoolReachable: settings.ui_devices_surplus_pool_reachable ?? true,
    }),
    'POST /ui_refresh_prices': () => buildPricesPayload(),
    'POST /ui_refresh_grid_tariff': () => buildPricesPayload(),
    'POST /ui_reset_power_stats': () => ({
      power: buildPowerPayload(),
      dailyBudget: resolveDailyBudgetRead(),
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
        active: activePayload ? { kind: 'budget', payload: activePayload } : { kind: 'unavailable' },
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
      return resolveDailyBudgetRead();
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
      lastPowerUpdateMs: Date.now() - 5 * 1000,
      softLimitKw: 8.0,
      capacitySoftLimitKw: 8.0,
      budgetPaceKw: null,
      projectedExemptKw: null,
      softLimitSource: 'capacity',
      headroomKw: 0,
      hardCapLimitKw: 8.0,
      usedKWh: 3.8,
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
        // Required on the plan snapshot: a binary load the owner sheds by turning off.
        name: 'Water Heater',
        currentState: 'on',
        plannedState: 'shed',
        priority: 2,
        controllable: true,
        available: true,
        expectedPowerKw: 2.0,
        currentDrawKw: 2.1,
        reason: { code: 'capacity', detail: 'capacity shortfall' },
        shedAction: 'turn_off',
      },
      {
        id: 'dev_evcharger',
        // Required on the plan snapshot: a binary load the owner sheds by turning off.
        name: 'Generic EV Charger',
        currentState: 'on',
        plannedState: 'shed',
        priority: 6,
        controllable: true,
        available: true,
        expectedPowerKw: 7.2,
        currentDrawKw: 6.8,
        reason: { code: 'capacity', detail: 'capacity shortfall' },
        shedAction: 'turn_off',
      },
    ],
  });

  const buildScenarioPressurePower = () => ({
    tracker: null,
    // The wire union, exactly as the producer serves it — a raw blob here
    // would be classified `read_failed` by the client seam and the audit
    // capture would render the missing-power state instead of the live
    // capacity-shortfall pressure it exists to show.
    status: {
      state: 'live',
      status: {
        capacityShortfall: true,
        shortfallBudgetThresholdKw: 8.0,
        shortfallBudgetHeadroomKw: 0,
        hardCapHeadroomKw: 0,
        headroomKw: 0,
        powerKnown: true,
        lastPowerUpdate: Date.now() - 5 * 1000,
      },
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
        deviceClass: 'thermostat',
        temperature: { currentTarget: 21, currentTemperature: 19 + (i % 5), plannedTarget: 21 },
        priority: 1 + (i % 5),
        controllable: true,
        available: true,
        expectedPowerKw: 0.4,
        currentDrawKw: i % 3 === 0 ? 0 : 0.32,
        reason: { code: 'keep', detail: null },
        shedAction: 'set_temperature',
        shedTemperature: 15,
      });
    }
    return {
      meta: {
        totalKw: 4.7,
        lastPowerUpdateMs: Date.now() - 5 * 1000,
        softLimitKw: 8.0,
        capacitySoftLimitKw: 8.0,
        budgetPaceKw: null,
        projectedExemptKw: null,
        softLimitSource: 'capacity',
        hardCapLimitKw: 8.0,
        headroomKw: 3.3,
        usedKWh: 1.2,
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
    'budget-allowance': () => ({
      description: 'Daily safe pace includes a visible allowance for devices outside today\'s budget.',
      plan: {
        meta: {
          totalKw: 12.5,
          lastPowerUpdateMs: Date.now() - 5 * 1000,
          softLimitKw: 12,
          capacitySoftLimitKw: 14,
          budgetPaceKw: 5,
          projectedExemptKw: 7,
          softLimitSource: 'daily',
          headroomKw: -0.5,
          hardCapLimitKw: 14,
          usedKWh: 6.2,
          hourBudgetKWh: 9,
          minutesRemaining: 21,
          controlledKw: 7.5,
          uncontrolledKw: 5,
        },
        devices: [
          {
            id: 'dev_budget_allowed_charger',
            // Required on the plan snapshot: a binary load the owner sheds by turning off.
            name: 'Garage Charger',
            currentState: 'on',
            plannedState: 'keep',
            priority: 6,
            controllable: true,
            available: true,
            budgetExempt: true,
            expectedPowerKw: 7,
            currentDrawKw: 7,
            reason: { code: 'keep', detail: null },
            shedAction: 'turn_off',
          },
          {
            id: 'dev_budget_limited_heater',
            // Required on the plan snapshot: a binary load the owner sheds by turning off.
            name: 'Hallway Heater',
            currentState: 'on',
            plannedState: 'shed',
            priority: 2,
            controllable: true,
            available: true,
            budgetExempt: false,
            expectedPowerKw: 0.5,
            currentDrawKw: 0.5,
            reason: { code: 'daily_budget', detail: null },
            shedAction: 'turn_off',
          },
        ],
      },
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

    // Mirror the real producer's routing: Homey registers an app API route on
    // the bare manifest path and express matches the PATHNAME, handing the
    // handler a separate `query` bag (firmware `ManagerApiLocal.onAppStart`
    // sends `args: { query, params, body }`; the apps SDK spreads it into the
    // handler context). So `GET /ui_plan?homeId=x` must resolve the SAME
    // handler as `GET /ui_plan` and pass the parsed query alongside the body —
    // keying handlers on the raw URI would reject every scoped read instead.
    // Hand-rolled rather than `URLSearchParams`: this stub is also evaluated in
    // a bare `vm` context by `auditScenarios.test.ts`, which supplies only the
    // globals it declares, so web APIs are not available here.
    const queryIndex = String(uri).indexOf('?');
    const path = queryIndex === -1 ? String(uri) : String(uri).slice(0, queryIndex);
    const query = {};
    if (queryIndex !== -1) {
      String(uri).slice(queryIndex + 1).split('&').forEach((pair) => {
        if (!pair) return;
        const eq = pair.indexOf('=');
        const rawKey = eq === -1 ? pair : pair.slice(0, eq);
        const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
        // Own-property assignment only, so a `?__proto__=x` query cannot walk
        // into the object's prototype — the same guard the runtime boundary
        // applies when it reads this parameter. A repeated parameter becomes an
        // array, mirroring express, so `?homeId=a&homeId=b` fails the
        // producer's string check here too instead of last-value-winning.
        const key = decodeURIComponent(rawKey);
        const value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
        const existing = Object.prototype.hasOwnProperty.call(query, key) ? query[key] : undefined;
        Object.defineProperty(query, key, {
          value: existing === undefined ? value : [].concat(existing, value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
    }
    const key = `${String(method).toUpperCase()} ${path}`;
    const handler = runtimeOverrides.apiHandlers[key] ?? apiHandlers[key];
    // Counted by the full URI so a spec can still tell a scoped fetch from a
    // whole-home one (the settings-UI `apiCache` keys entries the same way).
    const countKey = `${String(method).toUpperCase()} ${uri}`;
    runtimeOverrides.apiCallCounts[countKey] = (runtimeOverrides.apiCallCounts[countKey] ?? 0) + 1;

    setTimeout(() => {
      if (typeof callback !== 'function') return;
      try {
        if (!handler) {
          callback(new Error(`Homey stub: no handler for ${key}`));
          return;
        }
        const result = handler(body, query);
        // Mirror the real API producer: plan-history entries reach the UI with
        // the kind-split (°C/%) pairs resolved to flat `*Value` fields. Apply at
        // the dispatch chokepoint so BOTH the default handler and any per-test
        // `apiHandlers['GET /ui_deferred_objective_history']` override are
        // normalized (fixtures inject raw entries). Idempotent.
        callback(null, key === 'GET /ui_deferred_objective_history' ? resolveHistoryEntries(result) : result);
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
