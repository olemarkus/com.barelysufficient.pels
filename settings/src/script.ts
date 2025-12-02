import Sortable from 'sortablejs';

declare const Homey: any;

const qs = (selector: string) => document.querySelector(selector) as HTMLElement;

const toastEl = qs('#toast');
const statusBadge = qs('#status-badge');
const deviceList = qs('#device-list');
const emptyState = qs('#empty-state');
const refreshButton = qs('#refresh-button') as HTMLButtonElement;
const powerList = qs('#power-list');
const powerEmpty = qs('#power-empty');
const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));
const capacityForm = document.querySelector('#capacity-form') as HTMLFormElement;
const capacityLimitInput = document.querySelector('#capacity-limit') as HTMLInputElement;
const capacityMarginInput = document.querySelector('#capacity-margin') as HTMLInputElement;
const capacityDryRunInput = document.querySelector('#capacity-dry-run') as HTMLInputElement;
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
  statusBadge.textContent = busy ? 'Loading…' : 'Live';
  statusBadge.classList.toggle('ok', !busy);
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

    const ctrlWrap = document.createElement('div');
    ctrlWrap.className = 'device-row__target control-row__inputs';
    
    // Controllable checkbox
    const ctrlLabel = document.createElement('label');
    ctrlLabel.className = 'checkbox-field-inline';
    const ctrlInput = document.createElement('input');
    ctrlInput.type = 'checkbox';
    ctrlInput.checked = controllableMap[device.id] !== false;
    ctrlInput.addEventListener('change', async () => {
      controllableMap[device.id] = ctrlInput.checked;
      await setSetting('controllable_devices', controllableMap);
    });
    const ctrlText = document.createElement('span');
    ctrlText.textContent = 'Controllable';
    ctrlLabel.append(ctrlInput, ctrlText);
    
    // Price optimization checkbox
    const priceOptLabel = document.createElement('label');
    priceOptLabel.className = 'checkbox-field-inline';
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
    const priceOptText = document.createElement('span');
    priceOptText.textContent = 'Price opt';
    priceOptLabel.append(priceOptInput, priceOptText);
    
    ctrlWrap.append(ctrlLabel, priceOptLabel);

    row.append(nameWrap, ctrlWrap);
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

const getPowerUsage = async () => {
  const tracker = await getSetting('power_tracker_state');
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
    val.innerHTML = `<span class="chip"><strong>Energy</strong><span>${entry.kWh.toFixed(3)} kWh</span></span>`;

    row.append(hour, val);
    powerList.appendChild(row);
  });
};

const loadCapacitySettings = async () => {
  const limit = await getSetting('capacity_limit_kw');
  const margin = await getSetting('capacity_margin_kw');
  const dryRun = await getSetting('capacity_dry_run');
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  capacityLimitInput.value = typeof limit === 'number' ? limit.toString() : fallbackLimit.toString();
  capacityMarginInput.value = typeof margin === 'number' ? margin.toString() : fallbackMargin.toString();
  if (capacityDryRunInput) {
    capacityDryRunInput.checked = typeof dryRun === 'boolean' ? dryRun : true;
  }
};

const saveCapacitySettings = async () => {
  const limit = parseFloat(capacityLimitInput.value);
  const margin = parseFloat(capacityMarginInput.value);
  const dryRun = capacityDryRunInput ? capacityDryRunInput.checked : true;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Limit must be positive.');
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Margin must be non-negative.');
  await setSetting('capacity_limit_kw', limit);
  await setSetting('capacity_margin_kw', margin);
  await setSetting('capacity_dry_run', dryRun);
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
  const total = rows.length;
  rows.forEach((row, index) => {
    const id = row.dataset.deviceId;
    if (id) {
      // Higher in the list = higher priority to keep (shed later), so invert order.
      modeMap[id] = total - index;
    }
  });
  capacityPriorities[mode] = modeMap;
  // Only save priorities, don't change active mode
  await setSetting('capacity_priorities', capacityPriorities);
  await showToast(`Priorities saved for ${mode}.`, 'ok');
};

const saveTargets = async () => {
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
    planMeta.innerHTML = `<div>${powerText}</div><div>${headroomText}${budgetText}</div>`;
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
    tempLine.innerHTML = `<span class="plan-label">Temperature</span><span>${currentTemp} / target ${targetText}</span>`;

    const powerLine = document.createElement('div');
    powerLine.className = 'plan-meta-line';
    const currentPower = dev.currentState || 'unknown';
    const plannedPower =
      dev.plannedState === 'shed'
        ? 'off'
        : dev.plannedState === 'keep'
          ? currentPower
          : dev.plannedState || 'keep';
    const powerChanging = currentPower !== plannedPower;
    const powerText = powerChanging ? `${currentPower} → ${plannedPower}` : currentPower;
    powerLine.innerHTML = `<span class="plan-label">Power</span><span>${powerText}</span>`;

    const reasonLine = document.createElement('div');
    reasonLine.className = 'plan-meta-line';
    reasonLine.innerHTML = `<span class="plan-label">Reason</span><span>${dev.reason || 'Plan unchanged'}</span>`;

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
}

const loadPriceSettings = async () => {
  const priceArea = await getSetting('price_area');
  const providerSurcharge = await getSetting('provider_surcharge');
  const thresholdPercent = await getSetting('price_threshold_percent');
  const minDiffOre = await getSetting('price_min_diff_ore');

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
};

const savePriceSettings = async () => {
  const priceArea = priceAreaSelect?.value || 'NO1';
  const providerSurcharge = parseFloat(providerSurchargeInput?.value || '0') || 0;
  const thresholdPercent = parseInt(priceThresholdInput?.value || '25', 10) || 25;
  const minDiffOre = parseInt(priceMinDiffInput?.value || '0', 10) || 0;

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

  if (cheapHours.length === 0 && expensiveHours.length === 0) {
    const notice = document.createElement('div');
    notice.className = 'price-notice';
    const thresholdPct = data.thresholdPercent ?? 25;
    const minDiff = data.minDiffOre ?? 0;
    let noticeText = `All prices are within ${thresholdPct}% of average (${avgPrice.toFixed(0)} øre/kWh)`;
    if (minDiff > 0) {
      noticeText += ` or below ${minDiff} øre difference`;
    }
    notice.textContent = noticeText;
    priceList.appendChild(notice);
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
  chip.innerHTML = `<strong>${entry.total.toFixed(1)}</strong><span>øre/kWh</span>`;
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
    if (priceOptimizationEmpty) priceOptimizationEmpty.hidden = false;
    return;
  }

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
    statusBadge.textContent = 'Live';
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Failed';
    statusBadge.classList.add('warn');
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
      statusBadge.textContent = 'Unavailable';
      statusBadge.classList.add('warn');
      emptyState.hidden = false;
      emptyState.textContent = 'Homey SDK not available. Make sure you are logged in and opened the settings from Homey.';
      await showToast('Homey SDK not available. Check your Homey session/connection.', 'warn');
      return;
    }

    await homey.ready();

    // Listen for setting changes to auto-update UI (if supported)
    if (typeof homey.on === 'function') {
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
      });
    }

    showTab('devices');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    });
    await refreshDevices();
    const usage = await getPowerUsage();
    renderPowerUsage(usage);
    await loadCapacitySettings();
    await loadModeAndPriorities();
    renderPriorities(latestDevices);
    renderDevices(latestDevices);
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
        await showToast('Power stats reset.', 'ok');
      } catch (err) {
        await showToast(err.message || 'Failed to reset stats.', 'warn');
      }
    });

    // Price tab handlers
    await loadPriceSettings();
    await refreshPrices();
    await loadNettleieSettings();
    await refreshNettleie();
    await loadPriceOptimizationSettings();
    renderPriceOptimization(latestDevices);
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

    statusBadge.classList.add('ok');
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Failed';
    statusBadge.classList.add('warn');
    await showToast('Unable to load settings. Check the console for details.', 'warn');
  }
};

boot();
