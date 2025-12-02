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
    ctrlWrap.append(ctrlLabel);

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

  const sorted = [...devices].sort((a, b) => getPriority(b.id) - getPriority(a.id));

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

  const grouped = plan.devices.reduce((acc, dev) => {
    const zone = dev.zone || 'Unknown';
    if (!acc[zone]) acc[zone] = [];
    acc[zone].push(dev);
    return acc;
  }, {});

  Object.keys(grouped)
    .sort((a, b) => a.localeCompare(b))
    .forEach((zone) => {
      const header = document.createElement('div');
      header.className = 'zone-header';
      header.textContent = zone;
      planList.appendChild(header);

      grouped[zone]
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .forEach((dev) => {
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
    });
};

const refreshPlan = async () => {
  const plan = await getPlanSnapshot();
  renderPlan(plan);
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
    statusBadge.classList.add('ok');
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Failed';
    statusBadge.classList.add('warn');
    await showToast('Unable to load settings. Check the console for details.', 'warn');
  }
};

boot();
