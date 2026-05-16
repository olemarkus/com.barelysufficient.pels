import { SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX } from '../../../contracts/src/settingsUiApi.ts';

// The runtime API layer throws errors prefixed with
// `SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX` when the PELS app shell is wired
// up but the runtime services are not yet initialized (e.g. during the boot
// window after an app restart). UI callers treat this as a transient
// loading state rather than a hard error.
export const isAppNotReadyErrorMessage = (message: string): boolean => (
  message.includes(SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX)
);

export const isHomeyTransportErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  const isMissingHomeyApiAdapter = /\bhomey api (delete|get|post|put) \S+ not available\b/i.test(message);
  return lower.includes('homey sdk not ready')
    || lower.includes('network request failed')
    || lower.includes('socket hang up')
    || lower.includes('missing app id')
    || isMissingHomeyApiAdapter
    || lower.includes('callback-only signature not supported')
    || lower.includes('timeout')
    || lower.includes('cannot get /api/app/')
    || lower.includes('cannot post /api/app/')
    || lower.includes('cannot put /api/app/')
    || lower.includes('cannot delete /api/app/')
    || isAppNotReadyErrorMessage(message);
};

// Subset of transport errors that are worth retrying. The "Cannot METHOD
// /api/app/" family is Homey's 404 for unregistered endpoints — that's
// structural, not transient, so retrying just delays the eventual failure.
export const isRetryableHomeyTransportErrorMessage = (message: string): boolean => {
  const lower = message.toLowerCase();
  const isMissingHomeyApiAdapter = /\bhomey api (delete|get|post|put) \S+ not available\b/i.test(message);
  return lower.includes('homey sdk not ready')
    || lower.includes('network request failed')
    || lower.includes('socket hang up')
    || isMissingHomeyApiAdapter
    || lower.includes('timeout')
    || isAppNotReadyErrorMessage(message);
};
