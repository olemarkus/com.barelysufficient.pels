import type { SupportReportResponse, SupportReportSubject } from '../../../contracts/src/supportReport.ts';
import { SETTINGS_UI_DEVICE_LOG_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';
import { parseDeviceActivityPayload } from './activityHistoryPayload.ts';
import { callApi } from './homey.ts';
import { getTargetDevices } from './devices.ts';
import { getHomeIdForUiDevice, getHomeScope, readHomeMembership, refreshHomeScope } from './homeScope.ts';
import { state } from './state.ts';
import { SupportReportController } from './supportReportController.ts';
import type { ReportDeviceOption, SupportReportViewState } from './supportReportModel.ts';
import { renderSupportReportView } from './views/SupportReportView.tsx';
import { showToast } from './toast.ts';

export const SUPPORT_REPORT_PANEL = 'report-problem';
const SUPPORT_REPORT_PATH = '/support-report';
let refreshSequence = 0;
let contextInitialized = false;

const keepReportReference = (view: SupportReportViewState): void => {
  const url = new URL(window.location.href);
  if (url.searchParams.get('page') !== `settings/${SUPPORT_REPORT_PANEL}`) return;
  if (view.report) url.searchParams.set('reportId', view.report.document.id);
  else url.searchParams.delete('reportId');
  url.searchParams.set('reportHomeId', view.draft.subject.homeId);
  if (view.draft.subject.kind === 'device') url.searchParams.set('reportDeviceId', view.draft.subject.deviceId);
  else url.searchParams.delete('reportDeviceId');
  const { atMs } = view.draft;
  if (view.draft.when === 'custom' && Number.isFinite(atMs)) url.searchParams.set('reportAtMs', String(atMs));
  else url.searchParams.delete('reportAtMs');
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
};

const clearReportReference = (): void => {
  const url = new URL(window.location.href);
  if (url.searchParams.get('page') !== `settings/${SUPPORT_REPORT_PANEL}`) return;
  url.searchParams.delete('reportId');
  window.history.replaceState(window.history.state, '', url);
};

const focusReportStage = (surface: HTMLElement, previousStage: string | undefined): void => {
  const stage = surface.querySelector<HTMLElement>('[data-report-stage]');
  if (previousStage && stage && previousStage !== stage.dataset.reportStage && stage.getClientRects().length > 0) {
    stage.focus({ preventScroll: true });
    stage.scrollIntoView({ block: 'start' });
  }
};

const controller = new SupportReportController({
  prepare: (request) => callApi<SupportReportResponse>('POST', `${SUPPORT_REPORT_PATH}/prepare`, request),
  get: (id) => callApi<SupportReportResponse>('GET', `${SUPPORT_REPORT_PATH}/${encodeURIComponent(id)}`),
  send: (id) => callApi<SupportReportResponse>(
    'POST', `${SUPPORT_REPORT_PATH}/${encodeURIComponent(id)}/send`, { consent: true },
  ),
}, (view) => {
  const surface = document.getElementById('support-report-root');
  if (!surface) return;
  if (!view.recoveryId) keepReportReference(view);
  const scope = getHomeScope();
  const homeName = view.draft.subject.homeId === MAIN_HOME_ID ? 'Main home'
    : scope.areas.find((area) => area.homeId === view.draft.subject.homeId)?.name ?? 'Selected meter area';
  const history: unknown = window.history.state;
  const from = history && typeof history === 'object' && 'pelsFrom' in history ? history.pelsFrom : undefined;
  const backTarget = typeof from === 'string' && from && from !== SUPPORT_REPORT_PANEL ? from : 'settings';
  const previousStage = surface.querySelector<HTMLElement>('[data-report-stage]')?.dataset.reportStage;
  renderSupportReportView(surface, { state: view, homeName, backTarget, actions: {
    edit: (draft) => { clearReportReference(); controller.edit(draft); },
    submit: () => { clearReportReference(); return controller.submit(); },
    check: () => controller.check(),
    startAnother: () => { clearReportReference(); controller.startAnother(); },
    notice: (message) => controller.notice(message),
  } });
  focusReportStage(surface, previousStage);
});

export const setSupportReportContext = (subject: SupportReportSubject, atMs?: number): void => {
  contextInitialized = true;
  controller.selectContext(subject, atMs);
};

export const refreshSupportReport = async (): Promise<void> => {
  const request = ++refreshSequence;
  const params = new URLSearchParams(window.location.search);
  const reportId = params.get('reportId');
  // Claim the route before any asynchronous scope read, so an earlier report
  // response cannot replace this target while navigation is in progress.
  if (reportId) {
    contextInitialized = true;
    await Promise.all([controller.restore(reportId), refreshHomeScope()]);
  } else {
    controller.leaveSentReport();
    await refreshHomeScope();
  }
  if (request !== refreshSequence) return;
  if (!contextInitialized && !reportId) {
    const homeId = params.get('reportHomeId') || getHomeScope().selectedHomeId;
    const deviceId = params.get('reportDeviceId');
    const atMs = params.has('reportAtMs') ? Number(params.get('reportAtMs')) : undefined;
    setSupportReportContext(deviceId ? { kind: 'device', deviceId, homeId } : { kind: 'app', homeId },
      atMs !== undefined && Number.isFinite(atMs) ? atMs : undefined);
  }
  controller.show();
  await refreshReportDevices(request);
};

const refreshReportDevices = async (request: number): Promise<void> => {
  const devices = new Map<string, ReportDeviceOption>();
  let unavailable = false;
  const [current, history] = await Promise.allSettled([
    getTargetDevices(), callApi<unknown>('GET', SETTINGS_UI_DEVICE_LOG_PATH),
  ]);
  const currentDevices = current.status === 'fulfilled' ? current.value : state.latestDevices;
  const membership = readHomeMembership();
  if (membership.state === 'resolved') {
    for (const device of currentDevices) {
      devices.set(device.id, { id: device.id, name: device.name, homeId: getHomeIdForUiDevice(device.id) });
    }
  } else {
    unavailable = true;
  }
  if (current.status === 'rejected') unavailable = true;
  try {
    if (history.status === 'rejected') throw history.reason;
    const activity = parseDeviceActivityPayload(history.value);
    for (const entry of activity.entries) {
      if (current.status === 'fulfilled' && !currentDevices.some((device) => device.id === entry.deviceId)) {
        devices.set(entry.deviceId, {
          id: entry.deviceId, name: `${entry.deviceName} (recorded)`, homeId: MAIN_HOME_ID,
        });
      }
    }
  } catch { unavailable = true; }
  if (request !== refreshSequence) return;
  controller.setDevices([...devices.values()].sort((a, b) => a.name.localeCompare(b.name)), unavailable);
};

const openDeviceReport = async (button: HTMLElement, openPanel: (panel: string) => void,
  closeDeviceDetail: () => void): Promise<void> => {
  const deviceId = button.dataset.reportDeviceId;
  if (!deviceId) return;
  let homeId = button.dataset.reportHomeId;
  if (!homeId) {
    await refreshHomeScope();
    if (readHomeMembership().state !== 'resolved') {
      void showToast('Could not identify this device’s home. Try opening the report again.', 'warn');
      return;
    }
    homeId = getHomeIdForUiDevice(deviceId);
  }
  const atMs = button.dataset.reportAtMs === undefined ? undefined : Number(button.dataset.reportAtMs);
  setSupportReportContext({ kind: 'device', homeId, deviceId },
    atMs !== undefined && Number.isFinite(atMs) ? atMs : undefined);
  closeDeviceDetail();
  openPanel(SUPPORT_REPORT_PANEL);
};

/** Boot supplies navigation so page rendering never imports its own router. */
export const initSupportReportNavigation = (
  openPanel: (panel: string) => void, closeDeviceDetail: () => void,
): void => {
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('[data-report-device-id]');
    const deviceId = button?.dataset.reportDeviceId;
    if (!button || !deviceId) return;
    event.preventDefault();
    void openDeviceReport(button, openPanel, closeDeviceDetail);
  });
};
