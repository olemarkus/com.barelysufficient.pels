(() => {
  const listeners = Object.create(null);

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
        totalKw: 5.3,
        softLimitKw: 6.0,
        capacitySoftLimitKw: 6.0,
        dailySoftLimitKw: null,
        softLimitSource: 'capacity',
        headroomKw: 0.7,
        usedKWh: 3.1,
        budgetKWh: 4.0,
        minutesRemaining: 22,
        controlledKw: 2.15,
        uncontrolledKw: 3.15,
        hourControlledKWh: 1.1,
        hourUncontrolledKWh: 2.0,
      },
      devices: [
        {
          id: 'dev_heatpump',
          name: 'Living Room Heat Pump',
          currentState: 'on',
          plannedState: 'keep',
          currentTarget: 21,
          plannedTarget: 22,
          currentTemperature: 20.3,
          priority: 1,
          controllable: true,
          expectedPowerKw: 1.6,
          measuredPowerKw: 1.2,
          reason: 'Cheap hour, preheating',
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
          reason: 'Approaching capacity cap',
          shedAction: 'turn_off',
        },
        {
          id: 'dev_evcharger',
          name: 'EV Charger',
          currentState: 'off',
          plannedState: 'keep',
          priority: 3,
          controllable: true,
          expectedPowerKw: 7.2,
          measuredPowerKw: 0,
          reason: 'Waiting for headroom',
          shedAction: 'turn_off',
        },
      ],
    };
  };

  const buildSampleDailyBudgetPayload = () => {
    const now = new Date();
    const nowMs = now.getTime();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).getTime();

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

        // Rough price shape in "kr" units for the budget view.
        const p = 0.8 + 0.35 * Math.sin((i / 24) * Math.PI * 2 - Math.PI / 2);
        price.push(Number(p.toFixed(3)));
      }

      const dateKey = dateKeyUtc(dayStartMs);
      const currentBucketIndex = Math.max(0, Math.min(23, Math.floor((nowMs - dayStartMs) / (3600 * 1000))));
      const usedNowKWh = actualKWh.slice(0, currentBucketIndex + 1).reduce((sum, v) => sum + v, 0);
      const allowedNowKWh = allowedCumKWh[currentBucketIndex] ?? 0;
      const dailyBudgetKWh = 12;
      const remainingKWh = dailyBudgetKWh - usedNowKWh;
      const deviationKWh = usedNowKWh - allowedNowKWh;

      return {
        dateKey,
        timeZone: 'UTC',
        nowUtc: new Date(nowMs).toISOString(),
        dayStartUtc: new Date(dayStartMs).toISOString(),
        currentBucketIndex,
        budget: {
          enabled: true,
          dailyBudgetKWh,
          priceShapingEnabled: true,
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
        targets: [{ name: 'target_temperature', value: 21 }],
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
        id: 'dev_evcharger',
        name: 'EV Charger',
        deviceClass: 'evcharger',
        measuredPowerKw: 0,
        expectedPowerKw: 7.2,
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
    },
    controllable_devices: {
      dev_heatpump: true,
      dev_floorheat: false,
      dev_waterheater: true,
      dev_evcharger: true,
    },
    capacity_priorities: {
      Home: {
        dev_heatpump: 1,
        dev_waterheater: 2,
        dev_evcharger: 3,
        dev_floorheat: 4,
      },
    },
    mode_device_targets: {
      Home: {
        dev_heatpump: 21,
        dev_floorheat: 24,
      },
      Away: {
        dev_heatpump: 18,
        dev_floorheat: 19,
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

    // Plan snapshot
    device_plan_snapshot: buildSamplePlanSnapshot(),

    // Grid tariff settings
    nettleie_fylke: '03',
    nettleie_orgnr: '',
    nettleie_tariffgruppe: 'Husholdning',

    // Debug
    debug_logging_topics: [],
    debug_logging_enabled: false,
  };

  const apiHandlers = {
    'GET /daily_budget': () => buildSampleDailyBudgetPayload(),
    'GET /homey_devices': () => {
      // Used by advanced device logger/cleanup.
      return [
        { id: 'dev_heatpump', name: 'Living Room Heat Pump' },
        { id: 'dev_floorheat', name: 'Bathroom Floor Heat' },
        { id: 'dev_waterheater', name: 'Water Heater' },
        { id: 'dev_evcharger', name: 'EV Charger' },
      ];
    },
    'POST /log_homey_device': () => ({ ok: true }),
  };

  const api = (method, uri, bodyOrCallback, cbMaybe) => {
    let callback = cbMaybe;
    if (typeof bodyOrCallback === 'function') {
      callback = bodyOrCallback;
    }

    const key = `${String(method).toUpperCase()} ${uri}`;
    const handler = apiHandlers[key];

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
  };

  // Expose globally.
  window.Homey = Homey;
})();
