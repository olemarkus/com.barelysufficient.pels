const qs = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

const toastEl = qs('#toast');
const statusBadge = qs('#status-badge');
const deviceList = qs('#device-list');
const emptyState = qs('#empty-state');
const refreshButton = /** @type {HTMLButtonElement} */ (qs('#refresh-button'));

let isBusy = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const devices = await Homey.devices.getDevices();

  return Object.values(devices)
    .map((device) => {
      const capabilitiesObj = device.capabilitiesObj || {};
      const targetCapabilities = Object.keys(capabilitiesObj).filter((cap) => cap.startsWith('target_temperature'));

      if (!targetCapabilities.length) {
        return null;
      }

      const targets = targetCapabilities.map((capId) => ({
        id: capId,
        value: capabilitiesObj[capId]?.value ?? null,
        unit: capabilitiesObj[capId]?.units || '°C',
      }));

      return {
        id: device.id,
        name: device.name,
        targets,
      };
    })
    .filter(Boolean);
};

const refreshDevices = async () => {
  if (isBusy) return;
  setBusy(true);
  try {
    const devices = await getTargetDevices();
    renderDevices(devices);
    statusBadge.textContent = 'Live';
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Failed';
    statusBadge.classList.add('warn');
    await showToast('Unable to load devices. Check the console for details.', 'warn');
  } finally {
    setBusy(false);
  }
};

const boot = async () => {
  try {
    await Homey.ready();
    await refreshDevices();
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
