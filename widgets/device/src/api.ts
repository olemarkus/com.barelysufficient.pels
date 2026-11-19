import { getLogger } from '../../../lib/logging/logger';
import {
  endDeviceOverride, readDeviceOverrideForWrite, startDeviceOverrideUntil,
} from '../../../lib/overrides/deviceOverrides';
import type { SettingsPort } from '../../../lib/ports/homeyRuntime';
import type { TargetCapabilitySnapshot } from '../../../packages/contracts/src/types';
import {
  OVERRIDE_COPY, resolveOverrideDraft, type OverrideDraft,
} from '../../../packages/shared-domain/src/settings/deviceOverrideDraft';
import { parseDeviceOverride, type DeviceOverride } from '../../../packages/shared-domain/src/settings/deviceOverrides';
import { normalizeTargetCapabilityValue } from '../../../packages/shared-domain/src/targetCapabilities';
import { handleWidgetClientLog, type WidgetClientLogContext } from '../../_shared/widgetClientLogApi';
import { readPelsHost } from '../../../lib/app/pelsHost';
import {
  buildDeviceWidgetPayload, deviceWidgetOverrideRange, readDeviceWidgetOverrideTarget,
} from './deviceWidgetPayload';
import type {
  DeviceWidgetOverrideCommand, DeviceWidgetOverrideResponse, DeviceWidgetPayload,
} from './deviceWidgetTypes';

// The creation flow's routes are the Create smart task widget's own handlers: the
// same request, the same validation, the same app methods.
export {
  createCreateSmartTask,
  getCreateSmartTaskQuickTargets,
  previewCreateSmartTask,
} from '../../create_smart_task/src/api';

type WidgetApiContext = {
  homey: {
    app?: unknown;
    settings?: SettingsPort;
    // The widget API runs in the app process (often UTC), so the user's
    // timezone is plumbed explicitly for the tile's local times.
    clock?: { getTimezone?: () => string };
  };
  body?: unknown;
};

const readTimeZone = (homey: WidgetApiContext['homey']): string | null => {
  try {
    const tz = homey.clock?.getTimezone?.();
    if (typeof tz !== 'string' || tz.length === 0) return null;
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
};

const readDeviceId = (body: unknown): string | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { deviceId } = body as { deviceId?: unknown };
  return typeof deviceId === 'string' && deviceId.trim().length > 0 ? deviceId.trim() : null;
};

// The tile's read for the device in the body (`{ deviceId }`, from the widget's
// Device setting). An unknown or missing device reads as not managed.
export const getDeviceWidget = async ({ homey, body }: WidgetApiContext): Promise<DeviceWidgetPayload> => {
  const host = readPelsHost(homey);
  if (!host) return { state: 'starting' };
  const deviceId = readDeviceId(body);
  if (deviceId === null) return { state: 'not_managed' };
  return buildDeviceWidgetPayload(host, deviceId, Date.now(), readTimeZone(homey), homey.settings);
};

const readOverrideDraft = (raw: unknown): OverrideDraft | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { temperature, end, date, at } = raw as Record<string, unknown>;
  if (typeof temperature !== 'string' || typeof date !== 'string' || typeof at !== 'string'
    || (end !== 'two_hours' && end !== 'morning' && end !== 'custom')) return null;
  return { temperature, end, date, at };
};

const readOverrideCommand = (body: unknown): DeviceWidgetOverrideCommand | null => {
  const deviceId = readDeviceId(body);
  if (deviceId === null) return null;
  const { action, expected: rawExpected, draft: rawDraft } = body as Record<string, unknown>;
  const expected = parseDeviceOverride(rawExpected);
  if (expected === null && rawExpected !== null) return null;
  if (action === 'end' && expected !== null) return { deviceId, action, expected };
  if (action !== 'save') return null;
  const draft = readOverrideDraft(rawDraft);
  return draft === null ? null : { deviceId, action, draft, expected };
};

const matchesExpected = (active: DeviceOverride | null, expected: DeviceOverride | null): boolean => (
  active?.untilMs === expected?.untilMs && active?.setting.targetC === expected?.setting.targetC
);

const changeFailed: DeviceWidgetOverrideResponse = { ok: false, error: OVERRIDE_COPY.saveFailed };

const recordOverrideChange = (deviceId: string, action: 'save' | 'end'): void => {
  getLogger('deviceWidget').info({ event: 'device_widget_override_changed', deviceId, action });
};

const saveWidgetOverride = (
  settings: SettingsPort,
  request: Extract<DeviceWidgetOverrideCommand, { action: 'save' }>,
  target: TargetCapabilitySnapshot,
  nowMs: number,
  timeZone: string,
): DeviceWidgetOverrideResponse => {
  const resolved = resolveOverrideDraft(request.draft, deviceWidgetOverrideRange(target), nowMs, timeZone);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const targetC = normalizeTargetCapabilityValue({ target, value: resolved.targetC });
  const override: DeviceOverride = { setting: { type: 'temperature', targetC }, untilMs: resolved.untilMs };
  const result = startDeviceOverrideUntil(settings, request.deviceId, override, nowMs);
  if (result === 'temperature_control_off') return {
    ok: false, error: 'This device is set to Keep the new temperature.', refresh: true,
  };
  if (result !== 'written') return changeFailed;
  recordOverrideChange(request.deviceId, request.action);
  return { ok: true, active: override };
};

export const changeDeviceWidgetOverride = async (
  { homey, body }: WidgetApiContext,
): Promise<DeviceWidgetOverrideResponse> => {
  const request = readOverrideCommand(body);
  const host = readPelsHost(homey);
  if (!request || !host || !homey.settings) return changeFailed;
  const { deviceId, expected, action } = request;
  const { settings } = homey;
  const target = readDeviceWidgetOverrideTarget(host, deviceId);
  if (!target) return {
    ok: false, error: 'This device can no longer set an override in PELS.', refresh: true,
  };

  const nowMs = Date.now();
  const current = readDeviceOverrideForWrite(settings, deviceId, nowMs);
  if (current.state === 'unavailable') return {
    ok: false,
    error: 'Could not read the saved override. Try again or set the override on the device page in PELS.',
  };
  const { active } = current;
  if (active === null && action === 'end') return { ok: true, active: null };
  if (!matchesExpected(active, expected)) return {
    ok: false, error: 'The override has changed. Open it again to make your change.', refresh: true,
  };
  if (action === 'end') {
    if (endDeviceOverride(settings, deviceId, nowMs) !== 'written') return changeFailed;
    recordOverrideChange(deviceId, action);
    return { ok: true, active: null };
  }

  const timeZone = readTimeZone(homey);
  return timeZone ? saveWidgetOverride(settings, request, target, nowMs, timeZone) : changeFailed;
};

export const logClientError = (context: WidgetClientLogContext): { ok: boolean } => (
  handleWidgetClientLog('device', context)
);
