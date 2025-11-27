const GLOBAL_SETTING_KEY = 'global_target_temperature';

const qs = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));

const toastEl = qs('#toast');
const tempInput = /** @type {HTMLInputElement} */ (qs('#temperature-input'));
const formEl = /** @type {HTMLFormElement} */ (qs('#temperature-form'));
const reapplyButton = /** @type {HTMLButtonElement} */ (qs('#reapply-button'));
const pingButton = /** @type {HTMLButtonElement} */ (qs('#ping-action'));
const statusBadge = qs('#status-badge');

let state = {
  targetTemperature: 21,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const showToast = async (message, tone = 'default') => {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastEl.dataset.tone = tone;
  await sleep(1800);
  toastEl.classList.remove('show');
};

const setBusy = (isBusy) => {
  formEl.classList.toggle('is-busy', isBusy);
  formEl.querySelectorAll('button, input').forEach((el) => {
    el.disabled = isBusy;
  });
  statusBadge.textContent = isBusy ? 'Working…' : 'Idle';
  statusBadge.classList.toggle('ok', !isBusy);
};

const getSetting = (key) => new Promise((resolve, reject) => {
  Homey.get(key, (err, value) => {
    if (err) return reject(err);
    resolve(value);
  });
});

const setSetting = (key, value) => new Promise((resolve, reject) => {
  Homey.set(key, value, (err) => {
    if (err) return reject(err);
    resolve();
  });
});

const callApi = (method, path, body) => new Promise((resolve, reject) => {
  if (typeof Homey.api !== 'function') {
    return reject(new Error('Homey.api not available'));
  }

  Homey.api(method, path, body, (err, result) => {
    if (err) return reject(err);
    resolve(result);
  });
});

const refreshState = async () => {
  const stored = await getSetting(GLOBAL_SETTING_KEY);
  state = {
    targetTemperature: typeof stored === 'number' ? stored : state.targetTemperature,
  };
  tempInput.value = state.targetTemperature.toString();
};

const saveAndApply = async () => {
  const value = parseFloat(tempInput.value);
  if (Number.isNaN(value)) {
    throw new Error('Provide a numeric temperature value.');
  }

  await setSetting(GLOBAL_SETTING_KEY, value);
  state.targetTemperature = value;
};

const reapply = async () => {
  // Prefer a custom API action if available, otherwise fall back to re-saving the setting.
  try {
    await callApi('POST', '/actions/reapply-target', { targetTemperature: state.targetTemperature });
    await showToast('Triggered backend action.', 'ok');
  } catch (error) {
    await saveAndApply();
    await showToast('API unavailable; re-saved setting instead.', 'warn');
  }
};

const pingCustomAction = async () => {
  try {
    const result = await callApi('POST', '/actions/ping', { timestamp: Date.now() });
    await showToast(`Ping result: ${JSON.stringify(result)}`, 'ok');
  } catch (error) {
    await showToast('Custom API not wired yet. Update app.ts to handle /actions/ping.', 'warn');
  }
};

const attachEvents = () => {
  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await saveAndApply();
      await showToast('Saved and applied.', 'ok');
      statusBadge.textContent = 'Updated';
    } catch (error) {
      console.error(error);
      await showToast(error.message || 'Failed to save.', 'warn');
      statusBadge.textContent = 'Error';
      statusBadge.classList.add('warn');
    } finally {
      setBusy(false);
    }
  });

  reapplyButton.addEventListener('click', async () => {
    setBusy(true);
    try {
      await reapply();
    } catch (error) {
      console.error(error);
      await showToast('Failed to re-apply.', 'warn');
    } finally {
      setBusy(false);
    }
  });

  pingButton.addEventListener('click', async () => {
    setBusy(true);
    try {
      await pingCustomAction();
    } finally {
      setBusy(false);
    }
  });
};

const boot = async () => {
  try {
    await Homey.ready();
    attachEvents();
    await refreshState();
    statusBadge.classList.add('ok');
  } catch (error) {
    console.error(error);
    statusBadge.textContent = 'Failed';
    statusBadge.classList.add('warn');
    await showToast('Unable to load settings. Check the console for details.', 'warn');
  }
};

boot();
