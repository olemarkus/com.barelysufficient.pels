import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import {
  formatDeadlineLocalTime,
  parseSmartTaskQuickTargetsRequest,
} from '../../../lib/objectives/deferredObjectives';
import { rejectForSmartTaskHomeScope } from '../../../lib/objectives/deferredObjectives/smartTaskCreateLane';
import {
  createWidgetSmartTask,
  previewWidgetSmartTask,
} from '../../../lib/objectives/deferredObjectives/smartTaskWidgetCreateLane';
import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { CreateSmartTaskHostApi } from '../../../packages/contracts/src/widgetHostApi';
import { formatSmartTaskDeadlineLong } from '../../../packages/shared-domain/src/smartTaskDeadlineFormat';
import { buildCreateSmartTaskDevicesPayload } from './createSmartTaskWidgetPayload';
import type {
  CreateSmartTaskQuickTargetsResponse,
  CreateSmartTaskCreateResponse,
  CreateSmartTaskDevicesPayload,
  CreateSmartTaskPreviewResponse,
} from './createSmartTaskWidgetTypes';

// The widget API runs in the app process. Preview and create are decided in
// `lib/objectives/deferredObjectives/smartTaskWidgetCreateLane.ts`: the
// candidate parsing, the server-side "Ready by" (HH:mm local) → absolute
// `deadlineAtMs` conversion (DST-aware, against the Homey timezone), and the
// candidate validation. This file binds the app and the clock and forwards. The
// app methods the lane calls (`previewDeferredObjectivePlan`,
// `createDeferredObjective`) are the single source of truth for projection and
// persistence.

type WidgetApiContext = {
  homey: {
    app?: CreateSmartTaskHostApi;
    clock?: { getTimezone?: () => string };
  };
};

type WidgetApiBody = { body?: unknown };

const readTimeZone = (homey: WidgetApiContext['homey']): string => {
  const tz = homey.clock?.getTimezone?.();
  return typeof tz === 'string' && tz.length > 0 ? tz : 'UTC';
};

// The lane's clock: the Homey timezone, resolved when the lane reads it.
const laneClock = (homey: WidgetApiContext['homey']): { getTimezone(): string } => ({
  getTimezone: () => readTimeZone(homey),
});

export const getCreateSmartTaskDevices = async (
  { homey }: WidgetApiContext,
): Promise<CreateSmartTaskDevicesPayload> => {
  if (typeof homey.app?.getCreateSmartTaskCandidateDevices !== 'function') {
    return { state: 'error' };
  }
  const read = homey.app.getCreateSmartTaskCandidateDevices();
  if (read.state === 'unavailable') return { state: 'error' };
  return buildCreateSmartTaskDevicesPayload({ devices: read.devices });
};

export const previewCreateSmartTask = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<CreateSmartTaskPreviewResponse> => {
  // Hand the lane `homey.app` itself (never a detached method): the methods
  // rely on their `this` (`this.latestTargetSnapshot`, `this.getUiPickerDevices()`,
  // …), so a detached reference would throw a runtime TypeError.
  const host = typeof homey.app?.previewDeferredObjectivePlan === 'function'
    && typeof homey.app.resolveSmartTaskHomeScope === 'function'
    ? homey.app
    : null;
  return previewWidgetSmartTask({ host, clock: laneClock(homey) }, body);
};

// The quick-target boxes for one device. The body is `{ deviceId, kind }`, the
// goal the widget shows; the app picks the targets and times each one, so the
// widget only renders them.
export const getCreateSmartTaskQuickTargets = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<CreateSmartTaskQuickTargetsResponse> => {
  const request = parseSmartTaskQuickTargetsRequest(body);
  if (request === null) return { state: 'rejected', reason: 'invalid_request' };
  const { deviceId } = request;
  if (typeof homey.app?.previewSmartTaskQuickTargets !== 'function') {
    return { state: 'rejected', reason: 'unavailable' };
  }
  if (typeof homey.app.resolveSmartTaskHomeScope !== 'function') return { state: 'rejected', reason: 'unavailable' };
  const scopeReject = rejectForSmartTaskHomeScope(homey.app.resolveSmartTaskHomeScope(deviceId));
  if (scopeReject !== null) return { state: 'rejected', reason: scopeReject };
  const read = homey.app.previewSmartTaskQuickTargets(deviceId, request.kind);
  if (read.state === 'unavailable') return read;
  const timeZone = readTimeZone(homey);
  const nowMs = Date.now();
  return {
    state: 'ready',
    targets: read.targets.map(({ target, deadlineAtMs, estimate }) => ({
      target,
      deadlineAtMs,
      readyByLocalTime: formatDeadlineLocalTime(deadlineAtMs, timeZone),
      deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
      likelyFinishLocalTime: estimate.projectedFinishAtMs === null
        ? null
        : formatDeadlineLocalTime(estimate.projectedFinishAtMs, timeZone),
      // The boxes show energy, cost and finish only; the price curve is the
      // preview step's chart and stays out of this four-target payload.
      estimate: withoutPriceSeries(estimate),
    })),
  };
};

const withoutPriceSeries = (
  { priceSeries: _priceSeries, ...estimate }: DeferredObjectivePlanPreviewEstimate,
): DeferredObjectivePlanPreviewEstimate => estimate;

export const createCreateSmartTask = async (
  { homey, body }: WidgetApiContext & WidgetApiBody,
): Promise<CreateSmartTaskCreateResponse> => {
  // `homey.app` itself, for the same `this` reason as the preview.
  const host = typeof homey.app?.createDeferredObjective === 'function'
    && typeof homey.app.resolveSmartTaskHomeScope === 'function'
    ? homey.app
    : null;
  return createWidgetSmartTask({ host, clock: laneClock(homey) }, body);
};

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('create_smart_task', context)
);
