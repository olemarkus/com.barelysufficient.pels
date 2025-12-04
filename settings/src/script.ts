import Sortable from 'sortablejs';

declare const Homey: any;

const qs = (selector: string) => document.querySelector(selector) as HTMLElement;

/**
 * Escape HTML special characters to prevent XSS attacks.
 */
const _escapeHtml = (str: string): string => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

/**
 * Get a human-readable "time ago" string.
 */
const getTimeAgo = (date: Date, now: Date): string => {
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMins < 1) return 'just now';
  if (diffMins === 1) return '1 minute ago';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  return date.toLocaleString();
};

const toastEl = qs('#toast');
const deviceList = qs('#device-list');
const emptyState = qs('#empty-state');
const refreshButton = qs('#refresh-button') as HTMLButtonElement;
const powerList = qs('#power-list');
const powerEmpty = qs('#power-empty');
const dailyList = qs('#daily-list');
const dailyEmpty = qs('#daily-empty');
const usageToday = qs('#usage-today');
const usageWeek = qs('#usage-week');
const usageMonth = qs('#usage-month');
const usageWeekdayAvg = qs('#usage-weekday-avg');
const usageWeekendAvg = qs('#usage-weekend-avg');
const hourlyPattern = qs('#hourly-pattern');
const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));
const capacityForm = document.querySelector('#capacity-form') as HTMLFormElement;
const capacityLimitInput = document.querySelector('#capacity-limit') as HTMLInputElement;
const capacityMarginInput = document.querySelector('#capacity-margin') as HTMLInputElement;
const capacityDryRunInput = document.querySelector('#capacity-dry-run') as HTMLInputElement;
const dryRunBanner = qs('#dry-run-banner');
const planList = qs('#plan-list');
const planEmpty = qs('#plan-empty');
const planMeta = qs('#plan-meta');
const planRefreshButton = document.querySelector('#plan-refresh-button') as HTMLButtonElement;
const resetStatsButton = document.querySelector('#reset-stats-button') as HTMLButtonElement;
const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
const modeNewInput = document.querySelector('#mode-new') as HTMLInputElement;
const addModeButton = document.querySelector('#add-mode-button') as HTMLButtonElement;
const deleteModeButton = document.querySelector('#delete-mode-button') as HTMLButtonElement;
const renameModeButton = document.querySelector('#rename-mode-button') as HTMLButtonElement;
const activeModeForm = document.querySelector('#active-mode-form') as HTMLFormElement;
const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
const priorityForm = document.querySelector('#priority-form') as HTMLFormElement;
const priorityList = qs('#priority-list');
const priorityEmpty = qs('#priority-empty');
const priceList = qs('#price-list');
const priceEmpty = qs('#price-empty');
const priceStatusBadge = qs('#price-status-badge');
const priceSettingsForm = document.querySelector('#price-settings-form') as HTMLFormElement;
const priceAreaSelect = document.querySelector('#price-area') as HTMLSelectElement;
const providerSurchargeInput = document.querySelector('#provider-surcharge') as HTMLInputElement;
const priceThresholdInput = document.querySelector('#price-threshold-percent') as HTMLInputElement;
const priceMinDiffInput = document.querySelector('#price-min-diff-ore') as HTMLInputElement;
const priceRefreshButton = document.querySelector('#price-refresh-button') as HTMLButtonElement;
const nettleieSettingsForm = document.querySelector('#nettleie-settings-form') as HTMLFormElement;
const nettleieFylkeSelect = document.querySelector('#nettleie-fylke') as HTMLSelectElement;
const nettleieCompanySelect = document.querySelector('#nettleie-company') as HTMLSelectElement;
const nettleieOrgnrInput = document.querySelector('#nettleie-orgnr') as HTMLInputElement;
const nettleieTariffgruppeSelect = document.querySelector('#nettleie-tariffgruppe') as HTMLSelectElement;
const nettleieRefreshButton = document.querySelector('#nettleie-refresh-button') as HTMLButtonElement;
const priceOptimizationList = qs('#price-optimization-list');
const priceOptimizationEmpty = qs('#price-optimization-empty');
const priceOptimizationSection = qs('#price-optimization-section');
const priceOptimizationEnabledCheckbox = document.querySelector('#price-optimization-enabled') as HTMLInputElement;

// Device detail panel elements
const deviceDetailOverlay = qs('#device-detail-overlay');
const _deviceDetailPanel = qs('#device-detail-panel');
const deviceDetailTitle = qs('#device-detail-title');
const deviceDetailClose = qs('#device-detail-close') as HTMLButtonElement;
const deviceDetailControllable = document.querySelector('#device-detail-controllable') as HTMLInputElement;
const deviceDetailPriceOpt = document.querySelector('#device-detail-price-opt') as HTMLInputElement;
const deviceDetailModes = qs('#device-detail-modes');
const deviceDetailDeltaSection = qs('#device-detail-delta-section');
const deviceDetailCheapDelta = document.querySelector('#device-detail-cheap-delta') as HTMLInputElement;
const deviceDetailExpensiveDelta = document.querySelector('#device-detail-expensive-delta') as HTMLInputElement;
const deviceDetailSave = qs('#device-detail-save') as HTMLButtonElement;

let currentDetailDeviceId: string | null = null;

// Norwegian grid companies with organization numbers and counties
// Data from NVE nettleietariffer API
interface GridCompany {
  name: string;
  orgnr: string;
  fylker: string[]; // Company may operate in multiple counties
}

const gridCompanies: GridCompany[] = [
  { name: "ALUT AS", orgnr: "925336637", fylker: ["55", "56"] },
  { name: "AREA NETT AS", orgnr: "923993355", fylker: ["56"] },
  { name: "ARVA AS", orgnr: "979151950", fylker: ["18", "55"] },
  { name: "ASKER NETT AS", orgnr: "917743193", fylker: ["32"] },
  { name: "BARENTS NETT AS", orgnr: "971058854", fylker: ["56"] },
  { name: "BINDAL KRAFTLAG SA", orgnr: "953181606", fylker: ["18"] },
  { name: "BKK AS", orgnr: "976944801", fylker: ["46"] },
  { name: "BREHEIM NETT AS", orgnr: "924527994", fylker: ["46"] },
  { name: "BØMLO KRAFTNETT AS", orgnr: "923934138", fylker: ["46"] },
  { name: "DE NETT AS", orgnr: "924862602", fylker: ["40"] },
  { name: "ELINETT AS", orgnr: "979379455", fylker: ["15"] },
  { name: "ELMEA AS", orgnr: "986347801", fylker: ["18"] },
  { name: "ELVENETT AS", orgnr: "979497482", fylker: ["33"] },
  { name: "ELVIA AS", orgnr: "980489698", fylker: ["03", "31", "32", "33", "34"] },
  { name: "ENIDA AS", orgnr: "918312730", fylker: ["11", "42"] },
  { name: "ETNA NETT AS", orgnr: "882783022", fylker: ["34"] },
  { name: "EVERKET AS", orgnr: "966731508", fylker: ["40"] },
  { name: "FAGNE AS", orgnr: "915635857", fylker: ["11", "46"] },
  { name: "FØIE AS (Akershus)", orgnr: "987626844", fylker: ["32", "33"] },
  { name: "FØIE AS (Buskerud)", orgnr: "971589752", fylker: ["33"] },
  { name: "FØRE AS", orgnr: "925549738", fylker: ["40"] },
  { name: "GLITRE NETT AS", orgnr: "982974011", fylker: ["03", "11", "32", "33", "34", "40", "42", "46"] },
  { name: "GRIUG AS", orgnr: "953681781", fylker: ["34"] },
  { name: "HAVNETT AS", orgnr: "924004150", fylker: ["46"] },
  { name: "HEMSIL NETT AS", orgnr: "923050612", fylker: ["33"] },
  { name: "HØLAND OG SETSKOG ELVERK AS", orgnr: "923488960", fylker: ["32"] },
  { name: "INDRE HORDALAND KRAFTNETT AS", orgnr: "919415096", fylker: ["46"] },
  { name: "JÆREN EVERK AS", orgnr: "824914982", fylker: ["11"] },
  { name: "KE NETT AS", orgnr: "977285712", fylker: ["11"] },
  { name: "KVAM ENERGI NETT AS", orgnr: "923789324", fylker: ["46"] },
  { name: "KYSTNETT AS", orgnr: "923152601", fylker: ["18"] },
  { name: "LEDE AS", orgnr: "979422679", fylker: ["33", "39", "40"] },
  { name: "LEGA NETT AS", orgnr: "924868759", fylker: ["56"] },
  { name: "LINEA AS", orgnr: "917424799", fylker: ["18"] },
  { name: "LINJA AS", orgnr: "912631532", fylker: ["15", "46"] },
  { name: "LNETT AS", orgnr: "980038408", fylker: ["11"] },
  { name: "LUCERNA AS", orgnr: "982897327", fylker: ["56"] },
  { name: "LUOSTEJOK NETT AS", orgnr: "924934867", fylker: ["56"] },
  { name: "MELLOM AS", orgnr: "925668389", fylker: ["15"] },
  { name: "MELØY ENERGI AS", orgnr: "919173122", fylker: ["18"] },
  { name: "MIDTNETT AS", orgnr: "917856222", fylker: ["33"] },
  { name: "MODALEN KRAFTLAG SA", orgnr: "877051412", fylker: ["46"] },
  { name: "NETTSELSKAPET AS", orgnr: "921688679", fylker: ["50"] },
  { name: "NORANETT ANDØY AS", orgnr: "921680554", fylker: ["18", "55"] },
  { name: "NORANETT AS", orgnr: "985411131", fylker: ["18", "55"] },
  { name: "NORANETT HADSEL AS", orgnr: "917983550", fylker: ["18"] },
  { name: "NORDVEST NETT AS", orgnr: "980824586", fylker: ["15"] },
  { name: "NOREFJELL NETT AS", orgnr: "824701482", fylker: ["33"] },
  { name: "NORGESNETT AS", orgnr: "980234088", fylker: ["31", "32", "46"] },
  { name: "R-NETT AS", orgnr: "925067911", fylker: ["33"] },
  { name: "RAKKESTAD ENERGI AS", orgnr: "968398083", fylker: ["31"] },
  { name: "RK NETT AS", orgnr: "925017809", fylker: ["40"] },
  { name: "ROMSDALSNETT AS", orgnr: "926377841", fylker: ["15"] },
  { name: "RØROS E-VERK NETT AS", orgnr: "919884452", fylker: ["34", "50"] },
  { name: "S-NETT AS", orgnr: "923819177", fylker: ["15", "50"] },
  { name: "STANNUM AS", orgnr: "924940379", fylker: ["40"] },
  { name: "STRAM AS", orgnr: "914385261", fylker: ["18"] },
  { name: "STRAUMEN NETT AS", orgnr: "925354813", fylker: ["15"] },
  { name: "STRAUMNETT AS", orgnr: "922694435", fylker: ["46"] },
  { name: "SUNETT AS", orgnr: "924330678", fylker: ["15"] },
  { name: "SYGNIR AS", orgnr: "924619260", fylker: ["34", "46"] },
  { name: "SØR AURDAL ENERGI AS", orgnr: "997712099", fylker: ["34"] },
  { name: "TELEMARK NETT AS", orgnr: "925803375", fylker: ["40"] },
  { name: "TENDRANETT AS", orgnr: "918999361", fylker: ["46"] },
  { name: "TENSIO TN AS", orgnr: "988807648", fylker: ["18", "50"] },
  { name: "TENSIO TS AS", orgnr: "978631029", fylker: ["34", "50"] },
  { name: "TINFOS AS", orgnr: "916763476", fylker: ["40", "42", "56"] },
  { name: "UVDAL KRAFTFORSYNING SA", orgnr: "967670170", fylker: ["33"] },
  { name: "VANG ENERGIVERK AS", orgnr: "824368082", fylker: ["34", "46"] },
  { name: "VESTALL AS", orgnr: "968168134", fylker: ["18", "55"] },
  { name: "VESTMAR NETT AS", orgnr: "979399901", fylker: ["40"] },
  { name: "VEVIG AS", orgnr: "916319908", fylker: ["34"] },
  { name: "VISSI AS", orgnr: "921683057", fylker: ["55", "56"] },
];

let isBusy = false;
let homey: any = null;
let capacityPriorities: Record<string, Record<string, number>> = {};
let activeMode = 'Home'; // The mode currently active on Homey
let editingMode = 'Home'; // The mode currently being edited in the UI
let latestDevices: any[] = [];
let modeTargets: Record<string, Record<string, number>> = {};
let controllableMap: Record<string, boolean> = {};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
]);

const pollSetting = async (key, attempts = 10, delay = 300) => {
  for (let i = 0; i < attempts; i += 1) {
    const value = await getSetting(key);
    if (value) return value;
    await sleep(delay);
  }
  return null;
};

const getSetting = (key) => new Promise((resolve, reject) => {
  homey.get(key, (err, value) => {
    if (err) return reject(err);
    resolve(value);
  });
});

const setSetting = (key, value) => new Promise((resolve, reject) => {
  homey.set(key, value, (err) => {
    if (err) return reject(err);
    resolve();
  });
});

const showTab = (tabId) => {
  // Close overflow menu when switching tabs
  const overflowMenu = document.querySelector('.tab-overflow-menu') as HTMLElement;
  const overflowToggle = document.querySelector('.tab-overflow-toggle') as HTMLButtonElement;
  if (overflowMenu) overflowMenu.hidden = true;
  if (overflowToggle) overflowToggle.setAttribute('aria-expanded', 'false');

  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  panels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== tabId);
  });
  if (tabId === 'plan') {
    refreshPlan().catch(() => {});
  }
  if (tabId === 'price') {
    refreshPrices().catch(() => {});
  }
};

const showToast = async (message, tone = 'default') => {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastEl.dataset.tone = tone;
  await sleep(1800);
  toastEl.classList.remove('show');
};

const setBusy = (busy) => {
  isBusy = busy;
  refreshButton.disabled = busy;
};

const renderDevices = (devices) => {
  deviceList.innerHTML = '';

  if (!devices.length) {
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;

  devices.forEach((device) => {
    const row = document.createElement('div');
    row.className = 'device-row control-row';
    row.setAttribute('role', 'listitem');

    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-row__name';
    nameWrap.textContent = device.name;

    // Controllable checkbox (icon only)
    const ctrlLabel = document.createElement('label');
    ctrlLabel.className = 'checkbox-icon';
    ctrlLabel.title = 'Capacity-based control';
    const ctrlInput = document.createElement('input');
    ctrlInput.type = 'checkbox';
    ctrlInput.checked = controllableMap[device.id] !== false;
    ctrlInput.addEventListener('change', async () => {
      controllableMap[device.id] = ctrlInput.checked;
      await setSetting('controllable_devices', controllableMap);
    });
    ctrlLabel.append(ctrlInput);

    // Price optimization checkbox (icon only)
    const priceOptLabel = document.createElement('label');
    priceOptLabel.className = 'checkbox-icon';
    priceOptLabel.title = 'Price-based control';
    const priceOptInput = document.createElement('input');
    priceOptInput.type = 'checkbox';
    const config = priceOptimizationSettings[device.id];
    priceOptInput.checked = config?.enabled || false;
    priceOptInput.addEventListener('change', async () => {
      if (!priceOptimizationSettings[device.id]) {
        priceOptimizationSettings[device.id] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
      }
      priceOptimizationSettings[device.id].enabled = priceOptInput.checked;
      await savePriceOptimizationSettings();
      renderPriceOptimization(latestDevices);
    });
    priceOptLabel.append(priceOptInput);

    // Make the name clickable to open device detail
    nameWrap.style.cursor = 'pointer';
    nameWrap.addEventListener('click', () => {
      openDeviceDetail(device.id);
    });

    row.append(nameWrap, ctrlLabel, priceOptLabel);
    deviceList.appendChild(row);
  });
};

const getTargetDevices = async () => {
  const snapshot = await withTimeout(
    getSetting('target_devices_snapshot'),
    5000,
    'Timed out reading device snapshot from Homey.',
  );

  if (!Array.isArray(snapshot)) {
    return [];
  }

  return snapshot;
};

const getPlanSnapshot = async () => getSetting('device_plan_snapshot');

interface PowerTracker {
  buckets?: Record<string, number>;
  dailyTotals?: Record<string, number>;
  hourlyAverages?: Record<string, { sum: number; count: number }>;
}

const getPowerUsage = async () => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      return {
        hour: date,
        kWh: Number(value) || 0,
      };
    })
    .sort((a, b) => a.hour.getTime() - b.hour.getTime());
};

const getPowerStats = async () => {
  const tracker = await getSetting('power_tracker_state') as PowerTracker | null;
  if (!tracker || typeof tracker !== 'object') {
    return {
      today: 0,
      week: 0,
      month: 0,
      weekdayAvg: 0,
      weekendAvg: 0,
      hourlyPattern: [] as { hour: number; avg: number }[],
      dailyHistory: [] as { date: string; kWh: number }[],
    };
  }

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const todayStart = new Date(todayKey).getTime();

  // Calculate today's usage from hourly buckets
  let today = 0;
  if (tracker.buckets) {
    for (const [iso, kWh] of Object.entries(tracker.buckets)) {
      const ts = new Date(iso).getTime();
      if (ts >= todayStart) {
        today += kWh;
      }
    }
  }

  // Calculate week and month from daily totals + today's hourly
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week (Sunday)
  weekStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let week = today;
  let month = today;

  if (tracker.dailyTotals) {
    for (const [dateKey, kWh] of Object.entries(tracker.dailyTotals)) {
      const ts = new Date(dateKey).getTime();
      if (ts >= weekStart.getTime() && dateKey !== todayKey) {
        week += kWh;
      }
      if (ts >= monthStart.getTime() && dateKey !== todayKey) {
        month += kWh;
      }
    }
  }

  // Also add older hourly data that's still within the period
  if (tracker.buckets) {
    for (const [iso, kWh] of Object.entries(tracker.buckets)) {
      const ts = new Date(iso).getTime();
      if (ts < todayStart) {
        if (ts >= weekStart.getTime()) week += kWh;
        if (ts >= monthStart.getTime()) month += kWh;
      }
    }
  }

  // Calculate weekday/weekend averages from hourly patterns
  let weekdaySum = 0, weekdayCount = 0;
  let weekendSum = 0, weekendCount = 0;

  if (tracker.hourlyAverages) {
    for (const [key, data] of Object.entries(tracker.hourlyAverages)) {
      const [dayOfWeek] = key.split('_').map(Number);
      const dailyContribution = data.sum; // This is sum of hourly kWh for this day-hour slot
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        weekendSum += dailyContribution;
        weekendCount += data.count;
      } else {
        weekdaySum += dailyContribution;
        weekdayCount += data.count;
      }
    }
  }

  // Convert to daily averages (24 hours per day)
  const weekdayAvg = weekdayCount > 0 ? (weekdaySum / weekdayCount) * 24 : 0;
  const weekendAvg = weekendCount > 0 ? (weekendSum / weekendCount) * 24 : 0;

  // Build hourly pattern (average kWh per hour of day, across all days of week)
  const hourlyPattern: { hour: number; avg: number }[] = [];
  for (let h = 0; h < 24; h++) {
    let sum = 0, count = 0;
    if (tracker.hourlyAverages) {
      for (let d = 0; d < 7; d++) {
        const key = `${d}_${h}`;
        if (tracker.hourlyAverages[key]) {
          sum += tracker.hourlyAverages[key].sum;
          count += tracker.hourlyAverages[key].count;
        }
      }
    }
    hourlyPattern.push({ hour: h, avg: count > 0 ? sum / count : 0 });
  }

  // Build daily history (last 30 days from dailyTotals + hourly buckets)
  // First, aggregate hourly buckets into daily totals for recent days
  const dailyFromBuckets: Record<string, number> = {};
  if (tracker.buckets) {
    for (const [iso, kWh] of Object.entries(tracker.buckets)) {
      const dateKey = iso.slice(0, 10); // YYYY-MM-DD
      if (dateKey !== todayKey) { // Exclude today (incomplete)
        dailyFromBuckets[dateKey] = (dailyFromBuckets[dateKey] || 0) + kWh;
      }
    }
  }

  // Merge with existing dailyTotals (dailyTotals takes precedence for old data)
  const mergedDaily: Record<string, number> = { ...dailyFromBuckets };
  if (tracker.dailyTotals) {
    for (const [dateKey, kWh] of Object.entries(tracker.dailyTotals)) {
      mergedDaily[dateKey] = kWh; // Override with aggregated data if available
    }
  }

  const dailyHistory: { date: string; kWh: number }[] = Object.entries(mergedDaily)
    .map(([date, kWh]) => ({ date, kWh }))
    .sort((a, b) => b.date.localeCompare(a.date)) // Most recent first
    .slice(0, 30);

  return { today, week, month, weekdayAvg, weekendAvg, hourlyPattern, dailyHistory };
};

const renderPowerStats = async () => {
  const stats = await getPowerStats();

  // Summary cards
  if (usageToday) usageToday.textContent = `${stats.today.toFixed(1)} kWh`;
  if (usageWeek) usageWeek.textContent = `${stats.week.toFixed(1)} kWh`;
  if (usageMonth) usageMonth.textContent = `${stats.month.toFixed(1)} kWh`;

  // Weekday/weekend averages
  if (usageWeekdayAvg) usageWeekdayAvg.textContent = `${stats.weekdayAvg.toFixed(1)} kWh/day`;
  if (usageWeekendAvg) usageWeekendAvg.textContent = `${stats.weekendAvg.toFixed(1)} kWh/day`;

  // Hourly pattern visualization
  if (hourlyPattern) {
    hourlyPattern.innerHTML = '';
    const maxAvg = Math.max(...stats.hourlyPattern.map(p => p.avg), 0.1);

    for (const { hour, avg } of stats.hourlyPattern) {
      const bar = document.createElement('div');
      bar.className = 'hourly-bar';
      bar.title = `${hour}:00 - ${avg.toFixed(2)} kWh avg`;

      const fill = document.createElement('div');
      fill.className = 'hourly-bar__fill';
      const heightPct = Math.max(5, (avg / maxAvg) * 100);
      fill.style.height = `${heightPct}%`;

      const label = document.createElement('span');
      label.className = 'hourly-bar__label';
      label.textContent = hour % 6 === 0 ? `${hour}` : '';

      bar.append(fill, label);
      hourlyPattern.appendChild(bar);
    }
  }

  // Daily history list
  if (dailyList) {
    dailyList.innerHTML = '';
    if (stats.dailyHistory.length === 0) {
      if (dailyEmpty) dailyEmpty.hidden = false;
    } else {
      if (dailyEmpty) dailyEmpty.hidden = true;
      for (const { date, kWh } of stats.dailyHistory) {
        const row = document.createElement('div');
        row.className = 'device-row';
        row.setAttribute('role', 'listitem');

        const dateEl = document.createElement('div');
        dateEl.className = 'device-row__name';
        const d = new Date(date);
        const dayName = d.toLocaleDateString(undefined, { weekday: 'short' });
        dateEl.textContent = `${dayName} ${date}`;

        const val = document.createElement('div');
        val.className = 'device-row__target';
        const chip = document.createElement('span');
        chip.className = 'chip';
        const strong = document.createElement('strong');
        strong.textContent = 'Total';
        const span = document.createElement('span');
        span.textContent = `${kWh.toFixed(1)} kWh`;
        chip.append(strong, span);
        val.appendChild(chip);

        row.append(dateEl, val);
        dailyList.appendChild(row);
      }
    }
  }
};

const renderPowerUsage = (entries) => {
  powerList.innerHTML = '';
  if (!entries.length) {
    powerEmpty.hidden = false;
    return;
  }

  powerEmpty.hidden = true;
  entries.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.setAttribute('role', 'listitem');

    const hour = document.createElement('div');
    hour.className = 'device-row__name';
    hour.textContent = entry.hour.toLocaleString();

    const val = document.createElement('div');
    val.className = 'device-row__target';
    const chip = document.createElement('span');
    chip.className = 'chip';
    const strong = document.createElement('strong');
    strong.textContent = 'Energy';
    const span = document.createElement('span');
    span.textContent = `${entry.kWh.toFixed(3)} kWh`;
    chip.append(strong, span);
    val.appendChild(chip);

    row.append(hour, val);
    powerList.appendChild(row);
  });
};

const updateDryRunBanner = (isDryRun: boolean) => {
  if (dryRunBanner) {
    dryRunBanner.hidden = !isDryRun;
  }
};

const loadCapacitySettings = async () => {
  const limit = await getSetting('capacity_limit_kw');
  const margin = await getSetting('capacity_margin_kw');
  const dryRun = await getSetting('capacity_dry_run');
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  capacityLimitInput.value = typeof limit === 'number' ? limit.toString() : fallbackLimit.toString();
  capacityMarginInput.value = typeof margin === 'number' ? margin.toString() : fallbackMargin.toString();
  const isDryRun = typeof dryRun === 'boolean' ? dryRun : true;
  if (capacityDryRunInput) {
    capacityDryRunInput.checked = isDryRun;
  }
  updateDryRunBanner(isDryRun);
};

const saveCapacitySettings = async () => {
  const limit = parseFloat(capacityLimitInput.value);
  const margin = parseFloat(capacityMarginInput.value);
  const dryRun = capacityDryRunInput ? capacityDryRunInput.checked : true;

  // Validate limit: must be a finite positive number within reasonable bounds
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Limit must be positive.');
  if (limit > 1000) throw new Error('Limit cannot exceed 1000 kW.');

  // Validate margin: must be a finite non-negative number within reasonable bounds
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Margin must be non-negative.');
  if (margin > limit) throw new Error('Margin cannot exceed the limit.');

  await setSetting('capacity_limit_kw', limit);
  await setSetting('capacity_margin_kw', margin);
  await setSetting('capacity_dry_run', dryRun);
  updateDryRunBanner(dryRun);
  await showToast('Capacity settings saved.', 'ok');
};

const loadModeAndPriorities = async () => {
  const mode = await getSetting('capacity_mode');
  const priorities = await getSetting('capacity_priorities');
  const targets = await getSetting('mode_device_targets');
  const controllables = await getSetting('controllable_devices');
  activeMode = typeof mode === 'string' && mode.trim() ? mode : 'Home';
  editingMode = activeMode; // Start editing the active mode
  capacityPriorities = priorities && typeof priorities === 'object' ? priorities : {};
  modeTargets = targets && typeof targets === 'object' ? targets : {};
  controllableMap = controllables && typeof controllables === 'object' ? controllables : {};
  renderModeOptions();
};

// Refresh only the active mode (when changed externally), preserving editing mode
const refreshActiveMode = async () => {
  const mode = await getSetting('capacity_mode');
  activeMode = typeof mode === 'string' && mode.trim() ? mode : 'Home';
  // Only update the active mode dropdown, not the editing mode dropdown
  if (activeModeSelect) {
    activeModeSelect.value = activeMode;
  }
};

const renderModeOptions = () => {
  const modes = new Set([activeMode]);
  Object.keys(capacityPriorities || {}).forEach((m) => modes.add(m));
  Object.keys(modeTargets || {}).forEach((m) => modes.add(m));
  if (modes.size === 0) modes.add('Home');

  // Mode editor dropdown - shows editingMode as selected
  if (modeSelect) {
    modeSelect.innerHTML = '';
    Array.from(modes).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === editingMode) opt.selected = true;
      modeSelect.appendChild(opt);
    });
  }

  // Active mode dropdown - shows activeMode as selected
  if (activeModeSelect) {
    activeModeSelect.innerHTML = '';
    Array.from(modes).forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === activeMode) opt.selected = true;
      activeModeSelect.appendChild(opt);
    });
  }
};

const renderPriorities = (devices) => {
  if (!priorityList) return;
  priorityList.innerHTML = '';
  if (!devices.length) {
    priorityEmpty.hidden = false;
    return;
  }
  priorityEmpty.hidden = true;

  // Sort by priority ascending (1 = most important, shown at top)
  const sorted = [...devices].sort((a, b) => getPriority(a.id) - getPriority(b.id));

  sorted.forEach((device) => {
    const row = document.createElement('div');
    row.className = 'device-row draggable mode-row';
    row.draggable = true;
    row.setAttribute('role', 'listitem');
    row.dataset.deviceId = device.id;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '↕';

    const name = document.createElement('div');
    name.className = 'device-row__name';
    name.textContent = device.name;

    const controls = document.createElement('div');
    controls.className = 'device-row__target mode-row__inputs';
    const desired = getDesiredTarget(device);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.5';
    input.inputMode = 'decimal';
    input.placeholder = 'Desired °C';
    input.value = desired === null ? '' : desired.toString();
    input.dataset.deviceId = device.id;
    input.className = 'mode-target-input';
    input.addEventListener('change', () => {
      applyTargetChange(device.id, input.value);
    });
    const badge = document.createElement('span');
    badge.className = 'chip priority-badge';
    badge.textContent = '…';
    controls.append(input, badge);

    const badgeWrap = document.createElement('div');
    badgeWrap.className = 'mode-row__inputs';
    badgeWrap.appendChild(badge);

    row.append(handle, name, input, badgeWrap);
    priorityList.appendChild(row);
  });

  initSortable();
  refreshPriorityBadges();
};

const getPriority = (deviceId) => {
  const mode = editingMode || 'Home';
  return capacityPriorities[mode]?.[deviceId] ?? 100;
};

const getDesiredTarget = (device) => {
  const mode = editingMode || 'Home';
  const value = modeTargets[mode]?.[device.id];
  if (typeof value === 'number') return value;
  const firstTarget = device.targets?.find?.(() => true);
  if (firstTarget && typeof firstTarget.value === 'number') return firstTarget.value;
  return null;
};

const setActiveMode = (mode) => {
  const next = (mode || '').trim() || 'Home';
  activeMode = next;
  renderModeOptions();
  setSetting('capacity_mode', activeMode).catch(() => {});
};

const setEditingMode = (mode) => {
  const next = (mode || '').trim() || 'Home';
  editingMode = next;
  renderModeOptions();
  renderPriorities(latestDevices);
};

const renameMode = async (oldName, newName) => {
  const oldKey = (oldName || '').trim();
  const newKey = (newName || '').trim();
  if (!oldKey || !newKey || oldKey === newKey) return;
  if (capacityPriorities[newKey] || modeTargets[newKey]) {
    await showToast('Mode name already exists.', 'warn');
    return;
  }
  if (capacityPriorities[oldKey]) {
    capacityPriorities[newKey] = capacityPriorities[oldKey];
    delete capacityPriorities[oldKey];
  }
  if (modeTargets[oldKey]) {
    modeTargets[newKey] = modeTargets[oldKey];
    delete modeTargets[oldKey];
  }
  // If we're renaming the active mode, update it
  if (activeMode === oldKey) {
    activeMode = newKey;
    await setSetting('capacity_mode', activeMode);
  }
  // If we're renaming the mode we're editing, update it
  if (editingMode === oldKey) editingMode = newKey;
  await setSetting('capacity_priorities', capacityPriorities);
  await setSetting('mode_device_targets', modeTargets);
  renderModeOptions();
  renderPriorities(latestDevices);
  await showToast(`Renamed mode to ${newKey}`, 'ok');
};

const refreshPriorityBadges = () => {
  const rows = priorityList?.querySelectorAll('.device-row') || [];
  rows.forEach((row, index) => {
    const badge = row.querySelector('.priority-badge');
    if (badge) badge.textContent = `#${index + 1}`;
  });
};

let sortableInstance: Sortable | null = null;

const initSortable = () => {
  if (sortableInstance) {
    sortableInstance.destroy();
  }
  if (!priorityList) return;

  sortableInstance = new Sortable(priorityList, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    delay: 150,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    onEnd: async () => {
      refreshPriorityBadges();
      // Auto-save priorities after reordering
      await savePriorities();
    },
  });
};

const savePriorities = async () => {
  const mode = (modeSelect?.value || '').trim() || 'Home';
  editingMode = mode;
  const rows = priorityList?.querySelectorAll('.device-row') || [];
  const modeMap = capacityPriorities[mode] || {};
  const _total = rows.length;
  rows.forEach((row, index) => {
    const id = row.dataset.deviceId;
    if (id) {
      // Top of list = priority 1 (most important, shed last)
      modeMap[id] = index + 1;
    }
  });
  capacityPriorities[mode] = modeMap;
  // Only save priorities, don't change active mode
  await setSetting('capacity_priorities', capacityPriorities);
  await showToast(`Priorities saved for ${mode}.`, 'ok');
};

const _saveTargets = async () => {
  const mode = (modeSelect?.value || editingMode || 'Home').trim() || 'Home';
  editingMode = mode;
  const inputs = priorityList?.querySelectorAll('.mode-target-input') || [];
  const modeMap = modeTargets[mode] || {};
  inputs.forEach((input) => {
    const id = input.dataset.deviceId;
    const val = parseFloat(input.value);
    if (id && Number.isFinite(val)) {
      modeMap[id] = val;
    } else if (id) {
      delete modeMap[id];
    }
  });
  modeTargets[mode] = modeMap;
  // Only save targets, don't change active mode
  await setSetting('mode_device_targets', modeTargets);
  await showToast(`Targets saved for ${mode}.`, 'ok');
};

const applyTargetChange = async (deviceId, rawValue) => {
  const mode = (modeSelect?.value || editingMode || 'Home').trim() || 'Home';
  editingMode = mode;
  const val = parseFloat(rawValue);
  if (!Number.isFinite(val)) return;
  if (!modeTargets[mode]) modeTargets[mode] = {};
  modeTargets[mode][deviceId] = val;
  // Only save targets, don't change active mode
  await setSetting('mode_device_targets', modeTargets);
};

const renderPlan = (plan) => {
  planList.innerHTML = '';
  if (!plan || !Array.isArray(plan.devices) || plan.devices.length === 0) {
    planEmpty.hidden = false;
    planMeta.textContent = 'Awaiting data…';
    return;
  }
  planEmpty.hidden = true;

  const meta = plan.meta || {};
  if (typeof meta.totalKw === 'number' && typeof meta.softLimitKw === 'number' && typeof meta.headroomKw === 'number') {
    const headroomAbs = Math.abs(meta.headroomKw).toFixed(1);
    const headroomText = meta.headroomKw >= 0 ? `${headroomAbs}kW available` : `${headroomAbs}kW over limit`;
    const powerText = `Now ${meta.totalKw.toFixed(1)}kW / Limit ${meta.softLimitKw.toFixed(1)}kW`;
    const budgetText = typeof meta.usedKWh === 'number' && typeof meta.budgetKWh === 'number'
      ? ` · This hour: ${meta.usedKWh.toFixed(2)} of ${meta.budgetKWh.toFixed(1)}kWh`
      : '';
    planMeta.innerHTML = '';
    const powerDiv = document.createElement('div');
    powerDiv.textContent = powerText;
    const headroomDiv = document.createElement('div');
    headroomDiv.textContent = `${headroomText}${budgetText}`;
    planMeta.append(powerDiv, headroomDiv);
  } else {
    planMeta.textContent = 'Awaiting data';
  }

  // Sort all devices globally by priority (priority 1 = most important = first)
  const sortedDevices = [...plan.devices].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

  sortedDevices.forEach((dev) => {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.dataset.deviceId = dev.id;

    const name = document.createElement('div');
    name.className = 'device-row__name';
    name.textContent = dev.name;

    const metaWrap = document.createElement('div');
    metaWrap.className = 'device-row__target plan-row__meta';

    const tempLine = document.createElement('div');
    tempLine.className = 'plan-meta-line';
    const currentTemp = typeof dev.currentTemperature === 'number' ? `${dev.currentTemperature.toFixed(1)}°` : '–';
    const targetTemp = dev.currentTarget ?? '–';
    const plannedTemp = dev.plannedTarget ?? '–';
    const targetChanging = dev.plannedTarget != null && dev.plannedTarget !== dev.currentTarget;
    const targetText = targetChanging ? `${targetTemp}° → ${plannedTemp}°` : `${targetTemp}°`;
    const tempLabel = document.createElement('span');
    tempLabel.className = 'plan-label';
    tempLabel.textContent = 'Temperature';
    const tempValue = document.createElement('span');
    tempValue.textContent = `${currentTemp} / target ${targetText}`;
    tempLine.append(tempLabel, tempValue);

    const powerLine = document.createElement('div');
    powerLine.className = 'plan-meta-line';
    const currentPower = dev.currentState || 'unknown';
    const plannedPower
      = dev.plannedState === 'shed'
        ? 'off'
        : dev.plannedState === 'keep'
          ? currentPower
          : dev.plannedState || 'keep';
    const powerChanging = currentPower !== plannedPower;
    const powerText = powerChanging ? `${currentPower} → ${plannedPower}` : currentPower;
    const powerLabel = document.createElement('span');
    powerLabel.className = 'plan-label';
    powerLabel.textContent = 'Power';
    const powerValue = document.createElement('span');
    powerValue.textContent = powerText;
    powerLine.append(powerLabel, powerValue);

    const reasonLine = document.createElement('div');
    reasonLine.className = 'plan-meta-line';
    const reasonLabel = document.createElement('span');
    reasonLabel.className = 'plan-label';
    reasonLabel.textContent = 'Reason';
    const reasonValue = document.createElement('span');
    reasonValue.textContent = dev.reason || 'Plan unchanged';
    reasonLine.append(reasonLabel, reasonValue);

    metaWrap.append(name, tempLine, powerLine, reasonLine);

    row.append(metaWrap);
    planList.appendChild(row);
  });
};

const refreshPlan = async () => {
  const plan = await getPlanSnapshot();
  renderPlan(plan);
};

// Price settings and data
interface PriceEntry {
  startsAt: string;
  total: number;
  spotPrice?: number;
  nettleie?: number;
  isCheap?: boolean;
  isExpensive?: boolean;
}

interface CombinedPriceData {
  prices: PriceEntry[];
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
}

const loadPriceSettings = async () => {
  const priceArea = await getSetting('price_area');
  const providerSurcharge = await getSetting('provider_surcharge');
  const thresholdPercent = await getSetting('price_threshold_percent');
  const minDiffOre = await getSetting('price_min_diff_ore');
  const priceOptEnabled = await getSetting('price_optimization_enabled');

  if (priceAreaSelect) {
    priceAreaSelect.value = typeof priceArea === 'string' ? priceArea : 'NO1';
  }
  if (providerSurchargeInput) {
    providerSurchargeInput.value = typeof providerSurcharge === 'number' ? providerSurcharge.toString() : '0';
  }
  if (priceThresholdInput) {
    priceThresholdInput.value = typeof thresholdPercent === 'number' ? thresholdPercent.toString() : '25';
  }
  if (priceMinDiffInput) {
    priceMinDiffInput.value = typeof minDiffOre === 'number' ? minDiffOre.toString() : '0';
  }
  if (priceOptimizationEnabledCheckbox) {
    // Default to true if not set
    priceOptimizationEnabledCheckbox.checked = priceOptEnabled !== false;
  }
};

const savePriceSettings = async () => {
  const priceArea = priceAreaSelect?.value || 'NO1';
  const providerSurcharge = parseFloat(providerSurchargeInput?.value || '0') || 0;
  const thresholdPercent = parseInt(priceThresholdInput?.value || '25', 10) || 25;
  const minDiffOre = parseInt(priceMinDiffInput?.value || '0', 10) || 0;

  // Validate price area (whitelist of allowed values)
  const validPriceAreas = ['NO1', 'NO2', 'NO3', 'NO4', 'NO5'];
  if (!validPriceAreas.includes(priceArea)) throw new Error('Invalid price area.');

  // Validate surcharge: must be within reasonable bounds
  if (!Number.isFinite(providerSurcharge) || providerSurcharge < -100 || providerSurcharge > 1000) {
    throw new Error('Provider surcharge must be between -100 and 1000 øre.');
  }

  // Validate threshold percent: must be 0-100
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    throw new Error('Threshold must be between 0 and 100%.');
  }

  // Validate min diff: must be non-negative and reasonable
  if (!Number.isFinite(minDiffOre) || minDiffOre < 0 || minDiffOre > 1000) {
    throw new Error('Minimum difference must be between 0 and 1000 øre.');
  }

  await setSetting('price_area', priceArea);
  await setSetting('provider_surcharge', providerSurcharge);
  await setSetting('price_threshold_percent', thresholdPercent);
  await setSetting('price_min_diff_ore', minDiffOre);
  await showToast('Price settings saved.', 'ok');

  // Trigger refresh of spot prices
  await setSetting('refresh_spot_prices', Date.now());
  await refreshPrices();
};

const getPriceData = async (): Promise<CombinedPriceData | null> => {
  // Get combined_prices with pre-calculated thresholds from backend
  const combinedData = await getSetting('combined_prices');
  if (combinedData && typeof combinedData === 'object' && 'prices' in combinedData) {
    return combinedData as CombinedPriceData;
  }
  // Fall back to spot-only prices if combined not available (legacy format)
  if (combinedData && Array.isArray(combinedData) && combinedData.length > 0) {
    const prices = combinedData as PriceEntry[];
    const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / prices.length;
    return {
      prices,
      avgPrice,
      lowThreshold: avgPrice * 0.75,
      highThreshold: avgPrice * 1.25,
    };
  }
  const priceData = await getSetting('electricity_prices');
  if (!priceData || !Array.isArray(priceData) || priceData.length === 0) return null;
  const prices = priceData as PriceEntry[];
  const avgPrice = prices.reduce((sum, p) => sum + p.total, 0) / prices.length;
  return {
    prices,
    avgPrice,
    lowThreshold: avgPrice * 0.75,
    highThreshold: avgPrice * 1.25,
  };
};

const renderPrices = (data: CombinedPriceData | null) => {
  if (!priceList) return;
  priceList.innerHTML = '';

  if (!data || !data.prices || data.prices.length === 0) {
    if (priceEmpty) priceEmpty.hidden = false;
    if (priceStatusBadge) {
      priceStatusBadge.textContent = 'No data';
      priceStatusBadge.classList.remove('ok');
    }
    return;
  }

  if (priceEmpty) priceEmpty.hidden = true;

  const { prices, avgPrice, lowThreshold, highThreshold } = data;

  const now = new Date();
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);

  // Show prices starting from current hour in the list
  const futurePrices = prices.filter(p => new Date(p.startsAt) >= currentHour);

  if (futurePrices.length === 0) {
    if (priceEmpty) priceEmpty.hidden = false;
    return;
  }

  // Find current price
  const currentEntry = futurePrices.find(p => {
    const entryTime = new Date(p.startsAt);
    return entryTime.getTime() === currentHour.getTime();
  });

  if (priceStatusBadge && currentEntry) {
    priceStatusBadge.textContent = `Now: ${currentEntry.total.toFixed(1)} øre/kWh`;
    priceStatusBadge.classList.add('ok');
  }

  // Use pre-calculated cheap/expensive flags from backend
  const cheapHours = futurePrices.filter(p => p.isCheap).sort((a, b) => a.total - b.total);
  const expensiveHours = futurePrices.filter(p => p.isExpensive).sort((a, b) => b.total - a.total);

  if (cheapHours.length > 0) {
    const header = document.createElement('div');
    header.className = 'price-section-header cheap';
    header.textContent = `🟢 Cheap hours (< ${lowThreshold.toFixed(0)} øre)`;
    priceList.appendChild(header);

    cheapHours.forEach((entry) => {
      priceList.appendChild(createPriceRow(entry, currentHour, now, 'price-low'));
    });
  }

  if (expensiveHours.length > 0) {
    const header = document.createElement('div');
    header.className = 'price-section-header expensive';
    header.textContent = `🔴 Expensive hours (> ${highThreshold.toFixed(0)} øre)`;
    priceList.appendChild(header);

    expensiveHours.forEach((entry) => {
      priceList.appendChild(createPriceRow(entry, currentHour, now, 'price-high'));
    });
  }

  // Show notice and normal prices when no hours are flagged as cheap/expensive
  if (cheapHours.length === 0 && expensiveHours.length === 0) {
    const notice = document.createElement('div');
    notice.className = 'price-notice price-notice-info';
    const thresholdPct = data.thresholdPercent ?? 25;
    const minDiff = data.minDiffOre ?? 0;
    let noticeText = `ℹ️ No cheap or expensive hours found. All prices are within ${thresholdPct}% of average (${avgPrice.toFixed(0)} øre/kWh)`;
    if (minDiff > 0) {
      noticeText += ` and at least ${minDiff} øre difference is required`;
    }
    noticeText += '.';
    notice.textContent = noticeText;
    priceList.appendChild(notice);

    // Show all remaining hours in a "Normal prices" section
    const normalHours = futurePrices.filter(p => !p.isCheap && !p.isExpensive);
    if (normalHours.length > 0) {
      const header = document.createElement('div');
      header.className = 'price-section-header normal';
      header.textContent = `📊 All prices (avg ${avgPrice.toFixed(0)} øre/kWh)`;
      priceList.appendChild(header);

      normalHours.forEach((entry) => {
        priceList.appendChild(createPriceRow(entry, currentHour, now, 'price-normal'));
      });
    }
  }

  // Show notice if price data is limited (e.g., tomorrow's prices not yet available)
  const lastPriceTime = futurePrices.length > 0 ? new Date(futurePrices[futurePrices.length - 1].startsAt) : null;
  if (lastPriceTime) {
    const hoursRemaining = Math.floor((lastPriceTime.getTime() - now.getTime()) / (1000 * 60 * 60)) + 1;
    if (hoursRemaining <= 12) {
      const limitedNotice = document.createElement('div');
      limitedNotice.className = 'price-notice price-notice-warning';
      limitedNotice.textContent = `⚠️ Price data available for ${hoursRemaining} more hour${hoursRemaining === 1 ? '' : 's'}. Tomorrow's prices typically publish around 13:00.`;
      priceList.appendChild(limitedNotice);
    }
  }

  // Show last fetched timestamp
  if (data.lastFetched) {
    const lastFetchedDate = new Date(data.lastFetched);
    const timeAgo = getTimeAgo(lastFetchedDate, now);
    const lastFetchedNotice = document.createElement('div');
    lastFetchedNotice.className = 'price-last-fetched';
    lastFetchedNotice.textContent = `Last updated: ${timeAgo}`;
    priceList.appendChild(lastFetchedNotice);
  }
};

const createPriceRow = (entry: PriceEntry, currentHour: Date, now: Date, priceClass: string) => {
  const row = document.createElement('div');
  row.className = 'device-row price-row';
  row.setAttribute('role', 'listitem');

  const entryTime = new Date(entry.startsAt);
  const isCurrentHour = entryTime.getTime() === currentHour.getTime();
  if (isCurrentHour) row.classList.add('current-hour');

  const timeWrap = document.createElement('div');
  timeWrap.className = 'device-row__name';
  const timeStr = entryTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = entryTime.toDateString() !== now.toDateString()
    ? ` (${entryTime.toLocaleDateString([], { weekday: 'short' })})`
    : '';
  timeWrap.textContent = `${timeStr}${dateStr}${isCurrentHour ? ' ← now' : ''}`;

  const priceWrap = document.createElement('div');
  priceWrap.className = 'device-row__target';

  const chip = document.createElement('span');
  chip.className = `chip ${priceClass}`;
  const priceStrong = document.createElement('strong');
  priceStrong.textContent = entry.total.toFixed(1);
  const priceUnit = document.createElement('span');
  priceUnit.textContent = 'øre/kWh';
  chip.append(priceStrong, priceUnit);

  // Build tooltip with price breakdown
  const tooltipLines: string[] = [];
  if (typeof entry.spotPrice === 'number') {
    tooltipLines.push(`Spot: ${entry.spotPrice.toFixed(1)} øre`);
  }
  if (typeof entry.nettleie === 'number') {
    tooltipLines.push(`Nettleie: ${entry.nettleie.toFixed(1)} øre`);
  }
  // Calculate surcharge as the remainder
  if (typeof entry.spotPrice === 'number') {
    const surcharge = entry.total - entry.spotPrice - (entry.nettleie ?? 0);
    if (Math.abs(surcharge) >= 0.05) {
      tooltipLines.push(`Surcharge: ${surcharge.toFixed(1)} øre`);
    }
  }
  tooltipLines.push(`Total: ${entry.total.toFixed(1)} øre/kWh`);
  chip.dataset.tooltip = tooltipLines.join('\n');

  priceWrap.appendChild(chip);

  row.append(timeWrap, priceWrap);
  return row;
};

const refreshPrices = async () => {
  try {
    const prices = await getPriceData();
    renderPrices(prices);
  } catch (error) {
    console.error('Failed to load prices:', error);
    if (priceStatusBadge) {
      priceStatusBadge.textContent = 'Error';
      priceStatusBadge.classList.add('warn');
    }
  }
};

// Nettleie (Grid tariff) settings and data
interface NettleieEntry {
  time: number;
  energileddEks: number | null;
  energileddInk: number | null;
  fastleddEks: number | null;
  fastleddInk: number | null;
  datoId: string;
}

const loadNettleieSettings = async () => {
  const fylke = await getSetting('nettleie_fylke');
  const orgnr = await getSetting('nettleie_orgnr');
  const tariffgruppe = await getSetting('nettleie_tariffgruppe');

  if (nettleieFylkeSelect && typeof fylke === 'string') {
    nettleieFylkeSelect.value = fylke;
  }

  // Populate company dropdown based on fylke
  updateGridCompanyOptions(typeof fylke === 'string' ? fylke : '03');

  if (nettleieOrgnrInput && typeof orgnr === 'string') {
    nettleieOrgnrInput.value = orgnr;
    // Select the matching company in dropdown
    if (nettleieCompanySelect) {
      nettleieCompanySelect.value = orgnr;
    }
  }
  if (nettleieTariffgruppeSelect && typeof tariffgruppe === 'string') {
    nettleieTariffgruppeSelect.value = tariffgruppe;
  }
};

const updateGridCompanyOptions = (fylkeNr: string) => {
  if (!nettleieCompanySelect) return;

  const currentValue = nettleieOrgnrInput?.value || '';
  nettleieCompanySelect.innerHTML = '<option value="">-- Select grid company --</option>';

  // Filter companies that operate in the selected fylke
  const filteredCompanies = gridCompanies
    .filter(c => c.fylker.includes(fylkeNr))
    .sort((a, b) => a.name.localeCompare(b.name));

  filteredCompanies.forEach(company => {
    const opt = document.createElement('option');
    opt.value = company.orgnr;
    opt.textContent = company.name;
    if (company.orgnr === currentValue) opt.selected = true;
    nettleieCompanySelect.appendChild(opt);
  });
};

const saveNettleieSettings = async () => {
  const fylke = nettleieFylkeSelect?.value || '03';
  const orgnr = nettleieCompanySelect?.value || '';
  const tariffgruppe = nettleieTariffgruppeSelect?.value || 'Husholdning';

  // Also update hidden input for consistency
  if (nettleieOrgnrInput) nettleieOrgnrInput.value = orgnr;

  await setSetting('nettleie_fylke', fylke);
  await setSetting('nettleie_orgnr', orgnr);
  await setSetting('nettleie_tariffgruppe', tariffgruppe);
  await showToast('Grid tariff settings saved.', 'ok');

  // Trigger refresh of nettleie data
  await setSetting('refresh_nettleie', Date.now());
  await refreshNettleie();
};

const getNettleieData = async (): Promise<NettleieEntry[]> => {
  const data = await getSetting('nettleie_data');
  if (!data || !Array.isArray(data)) return [];
  return data as NettleieEntry[];
};

const refreshNettleie = async () => {
  try {
    // Just trigger a data refresh - the data is used by the backend for total price calculation
    await getNettleieData();
  } catch (error) {
    console.error('Failed to load nettleie:', error);
  }
};

// Price optimization settings
interface PriceOptimizationConfig {
  enabled: boolean;
  cheapDelta: number;    // Temperature increase during cheap hours (e.g., +5)
  expensiveDelta: number; // Temperature decrease during expensive hours (e.g., -5)
}

let priceOptimizationSettings: Record<string, PriceOptimizationConfig> = {};

const loadPriceOptimizationSettings = async () => {
  const settings = await getSetting('price_optimization_settings');
  if (settings && typeof settings === 'object') {
    priceOptimizationSettings = settings as Record<string, PriceOptimizationConfig>;
  }
};

const savePriceOptimizationSettings = async () => {
  await setSetting('price_optimization_settings', priceOptimizationSettings);
};

const renderPriceOptimization = (devices: any[]) => {
  if (!priceOptimizationList) return;
  priceOptimizationList.innerHTML = '';

  // Filter to only show devices with price optimization enabled
  const enabledDevices = (devices || []).filter((device) => {
    const config = priceOptimizationSettings[device.id];
    return config?.enabled === true;
  });

  if (enabledDevices.length === 0) {
    if (priceOptimizationSection) priceOptimizationSection.hidden = true;
    if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = false;
    return;
  }

  if (priceOptimizationSection) priceOptimizationSection.hidden = false;
  if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = true;

  enabledDevices.forEach((device) => {
    const config = priceOptimizationSettings[device.id] || {
      enabled: true,
      cheapDelta: 5,
      expensiveDelta: -5,
    };

    const row = document.createElement('div');
    row.className = 'device-row price-optimization-row';
    row.setAttribute('role', 'listitem');
    row.dataset.deviceId = device.id;

    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-row__name';
    nameWrap.textContent = device.name;

    // Cheap delta input (positive = increase temp during cheap hours)
    const cheapInput = document.createElement('input');
    cheapInput.type = 'number';
    cheapInput.step = '0.5';
    cheapInput.min = '-20';
    cheapInput.max = '20';
    cheapInput.className = 'price-opt-input';
    cheapInput.value = (config.cheapDelta ?? 5).toString();
    cheapInput.title = 'Temperature adjustment during cheap hours (e.g., +5 to boost)';
    cheapInput.addEventListener('change', async () => {
      const val = parseFloat(cheapInput.value);
      if (Number.isFinite(val)) {
        if (!priceOptimizationSettings[device.id]) {
          priceOptimizationSettings[device.id] = { enabled: true, cheapDelta: 5, expensiveDelta: -5 };
        }
        priceOptimizationSettings[device.id].cheapDelta = val;
        await savePriceOptimizationSettings();
      }
    });

    // Expensive delta input (negative = decrease temp during expensive hours)
    const expensiveInput = document.createElement('input');
    expensiveInput.type = 'number';
    expensiveInput.step = '0.5';
    expensiveInput.min = '-20';
    expensiveInput.max = '20';
    expensiveInput.className = 'price-opt-input';
    expensiveInput.value = (config.expensiveDelta ?? -5).toString();
    expensiveInput.title = 'Temperature adjustment during expensive hours (e.g., -5 to reduce)';
    expensiveInput.addEventListener('change', async () => {
      const val = parseFloat(expensiveInput.value);
      if (Number.isFinite(val)) {
        if (!priceOptimizationSettings[device.id]) {
          priceOptimizationSettings[device.id] = { enabled: true, cheapDelta: 5, expensiveDelta: -5 };
        }
        priceOptimizationSettings[device.id].expensiveDelta = val;
        await savePriceOptimizationSettings();
      }
    });

    row.append(nameWrap, cheapInput, expensiveInput);
    priceOptimizationList.appendChild(row);
  });
};

// ========================================
// Device Detail Panel Functions
// ========================================

const openDeviceDetail = (deviceId: string) => {
  const device = latestDevices.find(d => d.id === deviceId);
  if (!device) return;

  currentDetailDeviceId = deviceId;

  // Set title
  if (deviceDetailTitle) {
    deviceDetailTitle.textContent = device.name;
  }

  // Set control checkboxes
  if (deviceDetailControllable) {
    deviceDetailControllable.checked = controllableMap[deviceId] !== false;
  }

  const priceConfig = priceOptimizationSettings[deviceId];
  if (deviceDetailPriceOpt) {
    deviceDetailPriceOpt.checked = priceConfig?.enabled || false;
  }

  // Populate mode list
  renderDeviceDetailModes(device);

  // Set delta values
  if (deviceDetailCheapDelta) {
    deviceDetailCheapDelta.value = (priceConfig?.cheapDelta ?? 5).toString();
  }
  if (deviceDetailExpensiveDelta) {
    deviceDetailExpensiveDelta.value = (priceConfig?.expensiveDelta ?? -5).toString();
  }

  // Show/hide delta section based on price optimization enabled
  updateDeltaSectionVisibility();

  // Show panel
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = false;
  }
};

const closeDeviceDetail = () => {
  currentDetailDeviceId = null;
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = true;
  }
};

const updateDeltaSectionVisibility = () => {
  if (deviceDetailDeltaSection && deviceDetailPriceOpt) {
    deviceDetailDeltaSection.style.display = deviceDetailPriceOpt.checked ? 'block' : 'none';
  }
};

const renderDeviceDetailModes = (device: any) => {
  if (!deviceDetailModes) return;
  deviceDetailModes.innerHTML = '';

  // Collect all modes
  const modes = new Set([activeMode]);
  Object.keys(capacityPriorities || {}).forEach(m => modes.add(m));
  Object.keys(modeTargets || {}).forEach(m => modes.add(m));
  if (modes.size === 0) modes.add('Home');

  Array.from(modes).sort().forEach(mode => {
    const row = document.createElement('div');
    row.className = 'detail-mode-row';
    row.dataset.mode = mode;

    const nameWrap = document.createElement('div');
    nameWrap.className = 'detail-mode-row__name';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = mode;
    nameWrap.appendChild(nameSpan);

    if (mode === activeMode) {
      const badge = document.createElement('span');
      badge.className = 'active-badge';
      badge.textContent = 'Active';
      nameWrap.appendChild(badge);
    }

    // Get priority for this device in this mode
    const priority = capacityPriorities[mode]?.[device.id] ?? 100;
    const prioritySpan = document.createElement('div');
    prioritySpan.className = 'detail-mode-row__priority';
    prioritySpan.textContent = `Priority: #${priority <= 100 ? priority : '—'}`;
    nameWrap.appendChild(prioritySpan);

    // Temperature input
    const tempInput = document.createElement('input');
    tempInput.type = 'number';
    tempInput.step = '0.5';
    tempInput.inputMode = 'decimal';
    tempInput.placeholder = '°C';
    tempInput.className = 'detail-mode-temp';
    tempInput.dataset.mode = mode;

    // Get current target for this mode
    const currentTarget = modeTargets[mode]?.[device.id];
    const defaultTarget = device.targets?.[0]?.value;
    tempInput.value = typeof currentTarget === 'number' ? currentTarget.toString()
                      : (typeof defaultTarget === 'number' ? defaultTarget.toString() : '');

    row.append(nameWrap, tempInput);
    deviceDetailModes.appendChild(row);
  });
};

const saveDeviceDetail = async () => {
  if (!currentDetailDeviceId) return;

  const deviceId = currentDetailDeviceId;

  // Save controllable setting
  if (deviceDetailControllable) {
    controllableMap[deviceId] = deviceDetailControllable.checked;
    await setSetting('controllable_devices', controllableMap);
  }

  // Save price optimization settings
  const priceOptEnabled = deviceDetailPriceOpt?.checked || false;
  const cheapDelta = parseFloat(deviceDetailCheapDelta?.value || '5');
  const expensiveDelta = parseFloat(deviceDetailExpensiveDelta?.value || '-5');

  // Validate temperature deltas: must be within reasonable bounds (-20 to +20 degrees)
  const validCheapDelta = Number.isFinite(cheapDelta) && cheapDelta >= -20 && cheapDelta <= 20;
  const validExpensiveDelta = Number.isFinite(expensiveDelta) && expensiveDelta >= -20 && expensiveDelta <= 20;

  if (!priceOptimizationSettings[deviceId]) {
    priceOptimizationSettings[deviceId] = { enabled: false, cheapDelta: 5, expensiveDelta: -5 };
  }
  priceOptimizationSettings[deviceId].enabled = priceOptEnabled;
  priceOptimizationSettings[deviceId].cheapDelta = validCheapDelta ? cheapDelta : 5;
  priceOptimizationSettings[deviceId].expensiveDelta = validExpensiveDelta ? expensiveDelta : -5;
  await savePriceOptimizationSettings();

  // Save mode temperatures
  const tempInputs = deviceDetailModes?.querySelectorAll('.detail-mode-temp') as NodeListOf<HTMLInputElement>;
  tempInputs?.forEach(input => {
    const mode = input.dataset.mode;
    if (!mode) return;

    const value = parseFloat(input.value);
    if (!isNaN(value)) {
      if (!modeTargets[mode]) modeTargets[mode] = {};
      modeTargets[mode][deviceId] = value;
    }
  });
  await setSetting('mode_device_targets', modeTargets);

  // Refresh device list and close
  renderDevices(latestDevices);
  renderPriorities(latestDevices);
  renderPriceOptimization(latestDevices);

  closeDeviceDetail();
  await showToast('Device settings saved.', 'ok');
};

const initDeviceDetailHandlers = () => {
  // Close button
  deviceDetailClose?.addEventListener('click', closeDeviceDetail);

  // Overlay click (close on background click)
  deviceDetailOverlay?.addEventListener('click', (e) => {
    if (e.target === deviceDetailOverlay) {
      closeDeviceDetail();
    }
  });

  // Save button
  deviceDetailSave?.addEventListener('click', saveDeviceDetail);

  // Toggle delta section visibility when price opt changes
  deviceDetailPriceOpt?.addEventListener('change', updateDeltaSectionVisibility);

  // Escape key to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && deviceDetailOverlay && !deviceDetailOverlay.hidden) {
      closeDeviceDetail();
    }
  });
};

const refreshDevices = async () => {
  if (isBusy) return;
  setBusy(true);
  try {
    // Request backend to refresh snapshot; this triggers app settings listener.
    await setSetting('refresh_target_devices_snapshot', Date.now());
    // Wait for snapshot to be rebuilt
    await pollSetting('target_devices_snapshot', 10, 300);

    const devices = await getTargetDevices();
    latestDevices = devices;
    renderDevices(devices);
    renderPriorities(devices);
    renderPriceOptimization(devices);
    await refreshPlan();
  } catch (error) {
    console.error(error);
    await showToast(error.message || 'Unable to load devices. Check the console for details.', 'warn');
  } finally {
    setBusy(false);
  }
};

const waitForHomey = async (attempts = 50, interval = 100) => {
  const resolveHomey = () => {
    if (typeof Homey !== 'undefined') return Homey;
    if (typeof window !== 'undefined' && window.parent && window.parent.Homey) return window.parent.Homey;
    return null;
  };

  for (let i = 0; i < attempts; i += 1) {
    const candidate = resolveHomey();
    if (candidate && typeof candidate.ready === 'function' && typeof candidate.get === 'function') {
      homey = candidate;
      return candidate;
    }
    await sleep(interval);
  }
  return null;
};

const boot = async () => {
  try {
    const found = await waitForHomey(200, 100); // wait up to ~20s for embedded Homey SDK
    if (!found) {
      emptyState.hidden = false;
      emptyState.textContent = 'Homey SDK not available. Make sure you are logged in and opened the settings from Homey.';
      await showToast('Homey SDK not available. Check your Homey session/connection.', 'warn');
      return;
    }

    await homey.ready();

    // Listen for realtime events from the app (these are reliable, unlike settings.set)
    if (typeof homey.on === 'function') {
      // Plan updates via realtime event
      homey.on('plan_updated', (plan) => {
        const planPanel = document.querySelector('#plan-panel');
        if (planPanel && !planPanel.classList.contains('hidden')) {
          renderPlan(plan);
        }
      });

      // Listen for realtime prices updates from the app backend
      homey.on('prices_updated', () => {
        const pricesPanel = document.querySelector('#price-panel');
        if (pricesPanel && !pricesPanel.classList.contains('hidden')) {
          refreshPrices().catch(() => {});
        }
      });
      // Fallback: also listen for settings.set (may work in some scenarios)
      homey.on('settings.set', (key) => {
        if (key === 'device_plan_snapshot') {
          // Only auto-refresh if Plan tab is visible
          const planPanel = document.querySelector('#plan-panel');
          if (planPanel && !planPanel.classList.contains('hidden')) {
            refreshPlan().catch(() => {});
          }
        }
        if (key === 'combined_prices' || key === 'electricity_prices') {
          // Only auto-refresh if Prices tab is visible
          const pricesPanel = document.querySelector('#price-panel');
          if (pricesPanel && !pricesPanel.classList.contains('hidden')) {
            refreshPrices().catch(() => {});
          }
        }
        if (key === 'capacity_mode') {
          // Mode changed externally (e.g., via Flow) - refresh only active mode dropdown
          refreshActiveMode().catch(() => {});
        }
      });
    }

    showTab('devices');

    // Initialize overflow menu toggle
    const overflowToggle = document.querySelector('.tab-overflow-toggle') as HTMLButtonElement;
    const overflowMenu = document.querySelector('.tab-overflow-menu') as HTMLElement;
    if (overflowToggle && overflowMenu) {
      overflowToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isExpanded = overflowToggle.getAttribute('aria-expanded') === 'true';
        overflowToggle.setAttribute('aria-expanded', String(!isExpanded));
        overflowMenu.hidden = isExpanded;
      });
      // Close menu when clicking outside
      document.addEventListener('click', () => {
        overflowToggle.setAttribute('aria-expanded', 'false');
        overflowMenu.hidden = true;
      });
    }

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    });
    await refreshDevices();
    const usage = await getPowerUsage();
    renderPowerUsage(usage);
    await renderPowerStats();
    await loadCapacitySettings();
    await loadModeAndPriorities();
    await loadPriceOptimizationSettings(); // Load before rendering devices
    initDeviceDetailHandlers();
    renderPriorities(latestDevices);
    renderDevices(latestDevices);
    renderPriceOptimization(latestDevices);
    modeSelect?.addEventListener('change', () => {
      // Mode editor selection changes which mode we're editing, not the active mode
      setEditingMode(modeSelect.value || 'Home');
    });
    activeModeForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const mode = (activeModeSelect?.value || '').trim();
      if (!mode) return;
      setActiveMode(mode);
      await showToast(`Active mode set to ${mode}`, 'ok');
    });
    addModeButton?.addEventListener('click', async () => {
      const mode = (modeNewInput?.value || '').trim();
      if (!mode) return;
      if (!capacityPriorities[mode]) capacityPriorities[mode] = {};
      if (!modeTargets[mode]) modeTargets[mode] = {};
      editingMode = mode;
      renderModeOptions();
      renderPriorities(latestDevices);
      await setSetting('capacity_priorities', capacityPriorities);
      await setSetting('mode_device_targets', modeTargets);
      modeNewInput.value = '';
      await showToast(`Added mode ${mode}`, 'ok');
    });
    deleteModeButton?.addEventListener('click', async () => {
      const mode = modeSelect?.value || editingMode;
      if (mode && capacityPriorities[mode]) {
        delete capacityPriorities[mode];
        if (modeTargets[mode]) delete modeTargets[mode];
        // If we deleted the active mode, reset to Home
        if (activeMode === mode) {
          activeMode = 'Home';
          await setSetting('capacity_mode', activeMode);
        }
        editingMode = 'Home';
        renderModeOptions();
        renderPriorities(latestDevices);
        await setSetting('capacity_priorities', capacityPriorities);
        await setSetting('mode_device_targets', modeTargets);
        await showToast(`Deleted mode ${mode}`, 'warn');
      }
    });
    renameModeButton?.addEventListener('click', async () => {
      const oldMode = modeSelect?.value || editingMode;
      const newMode = (modeNewInput?.value || '').trim();
      if (!newMode) return;
      await renameMode(oldMode, newMode);
      modeNewInput.value = '';
    });
    capacityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await saveCapacitySettings();
      } catch (err) {
        await showToast(err.message || 'Failed to save capacity settings.', 'warn');
      }
    });
    // Priority form submit no longer needed - priorities auto-save on drag, temps auto-save on change
    priorityForm?.addEventListener('submit', (event) => {
      event.preventDefault();
    });
    refreshButton.addEventListener('click', refreshDevices);
    planRefreshButton?.addEventListener('click', refreshPlan);
    resetStatsButton?.addEventListener('click', async () => {
      try {
        await setSetting('power_tracker_state', {});
        renderPowerUsage([]);
        await renderPowerStats();
        await showToast('Power stats reset.', 'ok');
      } catch (err) {
        await showToast((err as Error).message || 'Failed to reset stats.', 'warn');
      }
    });

    // Price tab handlers
    await loadPriceSettings();
    await refreshPrices();
    await loadNettleieSettings();
    await refreshNettleie();
    priceSettingsForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await savePriceSettings();
      } catch (err) {
        await showToast(err.message || 'Failed to save price settings.', 'warn');
      }
    });
    priceRefreshButton?.addEventListener('click', async () => {
      await setSetting('refresh_spot_prices', Date.now());
      await refreshPrices();
    });
    priceOptimizationEnabledCheckbox?.addEventListener('change', async () => {
      await setSetting('price_optimization_enabled', priceOptimizationEnabledCheckbox.checked);
      await showToast(priceOptimizationEnabledCheckbox.checked ? 'Price optimization enabled.' : 'Price optimization disabled.', 'ok');
    });
    nettleieSettingsForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await saveNettleieSettings();
      } catch (err) {
        await showToast(err.message || 'Failed to save grid tariff settings.', 'warn');
      }
    });
    nettleieFylkeSelect?.addEventListener('change', () => {
      updateGridCompanyOptions(nettleieFylkeSelect.value);
    });
    nettleieRefreshButton?.addEventListener('click', async () => {
      await setSetting('refresh_nettleie', Date.now());
      await refreshNettleie();
    });
  } catch (error) {
    console.error(error);
    await showToast('Unable to load settings. Check the console for details.', 'warn');
  }
};

boot();
