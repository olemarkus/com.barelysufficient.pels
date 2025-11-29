const qs = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

const toastEl = qs('#toast');
const statusBadge = qs('#status-badge');
const deviceList = qs('#device-list');
const emptyState = qs('#empty-state');
const refreshButton = /** @type {HTMLButtonElement} */ (qs('#refresh-button'));
const powerList = qs('#power-list');
const powerEmpty = qs('#power-empty');
const tabs = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.panel'));
const capacityForm = /** @type {HTMLFormElement} */ (document.querySelector('#capacity-form'));
const capacityLimitInput = /** @type {HTMLInputElement} */ (document.querySelector('#capacity-limit'));
const capacityMarginInput = /** @type {HTMLInputElement} */ (document.querySelector('#capacity-margin'));

let isBusy = false;
let homey = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    row.className = 'device-row';
    row.setAttribute('role', 'listitem');

    const name = document.createElement('div');
    name.className = 'device-row__name';
    name.textContent = device.name;

    const targets = document.createElement('div');
    targets.className = 'device-row__target';
    targets.innerHTML = device.targets.map((target) => {
      const value = target.value === null || target.value === undefined ? '—' : target.value;
      const unit = target.unit || '°C';
      return `<span class="chip"><strong>${target.id}</strong><span>${value} ${unit}</span></span>`;
    }).join('');

    row.append(name, targets);
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

const getPowerUsage = async () => {
  const tracker = await getSetting('power_tracker_state');
  if (!tracker || typeof tracker !== 'object' || !tracker.buckets) return [];

  return Object.entries(tracker.buckets)
    .map(([iso, value]) => {
      const date = new Date(iso);
      return {
        hour: date,
        kWh: (Number(value) || 0) / 1000,
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
  const fallbackLimit = 10;
  const fallbackMargin = 0.2;
  capacityLimitInput.value = typeof limit === 'number' ? limit.toString() : fallbackLimit.toString();
  capacityMarginInput.value = typeof margin === 'number' ? margin.toString() : fallbackMargin.toString();
};

const saveCapacitySettings = async () => {
  const limit = parseFloat(capacityLimitInput.value);
  const margin = parseFloat(capacityMarginInput.value);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Limit must be positive.');
  if (!Number.isFinite(margin) || margin < 0) throw new Error('Margin must be non-negative.');
  await setSetting('capacity_limit_kw', limit);
  await setSetting('capacity_margin_kw', margin);
  await showToast('Capacity settings saved.', 'ok');
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
    renderDevices(devices);
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
    showTab('devices');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    });
    await refreshDevices();
    const usage = await getPowerUsage();
    renderPowerUsage(usage);
    await loadCapacitySettings();
    capacityForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await saveCapacitySettings();
      } catch (err) {
        await showToast(err.message || 'Failed to save capacity settings.', 'warn');
      }
    });
    refreshButton.addEventListener('click', refreshDevices);
    statusBadge.classList.add('ok');
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Failed';
    statusBadge.classList.add('warn');
    await showToast('Unable to load settings. Check the console for details.', 'warn');
  }
};

boot();
