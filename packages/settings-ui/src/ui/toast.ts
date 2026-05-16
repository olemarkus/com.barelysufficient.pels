import { toastEl } from './dom.ts';
import {
  isAppNotReadyErrorMessage,
  isHomeyTransportErrorMessage,
} from './homeyTransportErrors.ts';
import { sleep } from './homey.ts';

export type ToastTone = 'default' | 'ok' | 'warn';

export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
};

export type ToastOptions = {
  action?: ToastAction;
  durationMs?: number;
};

const DEFAULT_DURATION_MS = 1800;
const ACTION_DURATION_MS = 6000;
const ERROR_DURATION_MS = 5000;
const GENERIC_ERROR_FALLBACK = 'Save failed — try again.';
// Generic message shown when the PELS app shell is reachable but the runtime
// services have not finished initializing. Avoids surfacing the internal
// sentinel prefix to users when the boot window outlives the retry budget.
const APP_NOT_READY_FALLBACK = 'PELS is still starting — try again in a moment.';
// Wrap added by buildApiError in homey.ts. Strip so users see the inner
// server-authored message instead of the transport envelope.
const HOMEY_API_ERROR_PREFIX_REGEX = /^Homey api (?:DELETE|GET|POST|PUT) \S+ failed: /;
let hideToken = 0;

const clearToast = () => {
  toastEl.classList.remove('show');
  toastEl.textContent = '';
  delete toastEl.dataset.tone;
};

const buildActionButton = (action: ToastAction, dismiss: () => void): HTMLElement => {
  const button = document.createElement('md-text-button');
  button.setAttribute('type', 'button');
  button.className = 'toast__action';
  button.textContent = action.label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    dismiss();
    void action.onClick();
  });
  return button;
};

export const showToast = async (
  message: string,
  tone: ToastTone = 'default',
  options: ToastOptions = {},
): Promise<void> => {
  const token = hideToken + 1;
  hideToken = token;

  toastEl.textContent = '';
  const messageEl = document.createElement('span');
  messageEl.className = 'toast__message';
  messageEl.textContent = message;
  toastEl.appendChild(messageEl);

  let actionInvoked = false;
  if (options.action) {
    const button = buildActionButton(options.action, () => {
      actionInvoked = true;
      hideToken += 1;
      clearToast();
    });
    toastEl.appendChild(button);
  }

  toastEl.classList.add('show');
  toastEl.dataset.tone = tone;

  const duration = options.durationMs ?? (options.action ? ACTION_DURATION_MS : DEFAULT_DURATION_MS);
  await sleep(duration);

  if (actionInvoked || token !== hideToken) return;
  clearToast();
};

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return '';
};

const stripHomeyApiPrefix = (message: string): string => (
  message.replace(HOMEY_API_ERROR_PREFIX_REGEX, '')
);

export const showToastError = async (error: unknown, fallback: string): Promise<void> => {
  const rawMessage = extractErrorMessage(error);
  const unwrapped = stripHomeyApiPrefix(rawMessage);
  // App-not-ready outlasted the bounded retry budget: prefer a stable "still
  // starting" message over the sentinel prefix or the caller's generic fallback.
  if (isAppNotReadyErrorMessage(rawMessage)) {
    await showToast(APP_NOT_READY_FALLBACK, 'warn', { durationMs: ERROR_DURATION_MS });
    return;
  }
  // Hide low-signal transport errors behind the caller's fallback. The user
  // sees an actionable message instead of "socket hang up" or similar.
  const candidate = unwrapped && !isHomeyTransportErrorMessage(unwrapped) ? unwrapped : fallback;
  const message = candidate.trim() || GENERIC_ERROR_FALLBACK;
  await showToast(message, 'warn', { durationMs: ERROR_DURATION_MS });
};
