type SettingsUiHomeyPerf = {
  apiCalls: number;
  apiCacheHits: number;
  apiPaths: Record<string, number>;
  getCalls: number;
  getKeys: Record<string, number>;
  setCalls: number;
  setKeys: Record<string, number>;
  settingsCacheHits: number;
};

export type SettingsUiPerfSnapshot = {
  homey: SettingsUiHomeyPerf;
  marks: Record<string, number>;
  measures: Record<string, number>;
  ready: boolean;
};

type SettingsUiPerfWindow = Window & {
  __PELS_SETTINGS_UI_PERF__?: SettingsUiPerfSnapshot;
};

const createSnapshot = (): SettingsUiPerfSnapshot => ({
  homey: {
    apiCalls: 0,
    apiCacheHits: 0,
    apiPaths: {},
    getCalls: 0,
    getKeys: {},
    setCalls: 0,
    setKeys: {},
    settingsCacheHits: 0,
  },
  marks: {},
  measures: {},
  ready: false,
});

let fallbackSnapshot = createSnapshot();

const getNow = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

export const getSettingsUiPerfSnapshot = (): SettingsUiPerfSnapshot => {
  if (typeof window === 'undefined') {
    return fallbackSnapshot;
  }
  const perfWindow = window as SettingsUiPerfWindow;
  if (!perfWindow.__PELS_SETTINGS_UI_PERF__) {
    perfWindow.__PELS_SETTINGS_UI_PERF__ = createSnapshot();
  }
  return perfWindow.__PELS_SETTINGS_UI_PERF__;
};

export const resetSettingsUiPerf = () => {
  fallbackSnapshot = createSnapshot();
  if (typeof window !== 'undefined') {
    (window as SettingsUiPerfWindow).__PELS_SETTINGS_UI_PERF__ = createSnapshot();
  }
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.settingsUiReady = 'false';
  }
};

export const markSettingsUi = (name: string) => {
  const snapshot = getSettingsUiPerfSnapshot();
  const markName = `pels-settings-ui:${name}`;
  snapshot.marks[name] = getNow();
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(markName);
    } catch {
      // Ignore duplicate/unsupported marks in test environments.
    }
  }
};

export const measureSettingsUi = (name: string, startMark: string, endMark: string) => {
  const snapshot = getSettingsUiPerfSnapshot();
  const start = snapshot.marks[startMark];
  const end = snapshot.marks[endMark];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;
  snapshot.measures[name] = Math.max(0, end - start);
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure(
        `pels-settings-ui:${name}`,
        `pels-settings-ui:${startMark}`,
        `pels-settings-ui:${endMark}`,
      );
    } catch {
      // Ignore unsupported measure lookups in test environments.
    }
  }
};

export const markSettingsUiReady = () => {
  const snapshot = getSettingsUiPerfSnapshot();
  snapshot.ready = true;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.settingsUiReady = 'true';
  }
};

export const countSettingsCacheHit = () => {
  getSettingsUiPerfSnapshot().homey.settingsCacheHits += 1;
};

export const countApiCacheHit = () => {
  getSettingsUiPerfSnapshot().homey.apiCacheHits += 1;
};

export const countHomeyGet = (key: string) => {
  const homeyPerf = getSettingsUiPerfSnapshot().homey;
  homeyPerf.getCalls += 1;
  homeyPerf.getKeys[key] = (homeyPerf.getKeys[key] || 0) + 1;
};

export const countHomeySet = (key: string) => {
  const homeyPerf = getSettingsUiPerfSnapshot().homey;
  homeyPerf.setCalls += 1;
  homeyPerf.setKeys[key] = (homeyPerf.setKeys[key] || 0) + 1;
};

export const countHomeyApi = (method: string, uri: string) => {
  const homeyPerf = getSettingsUiPerfSnapshot().homey;
  const key = `${method.toUpperCase()} ${uri}`;
  homeyPerf.apiCalls += 1;
  homeyPerf.apiPaths[key] = (homeyPerf.apiPaths[key] || 0) + 1;
};
