import { toastEl } from './dom.ts';
import { sleep } from './homey.ts';

export type ToastTone = 'default' | 'ok' | 'warn';

export const showToast = async (message: string, tone: ToastTone = 'default') => {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastEl.dataset.tone = tone;
  await sleep(1800);
  toastEl.classList.remove('show');
};

export const showToastError = async (error: unknown, fallback: string) => {
  const message = error instanceof Error && error.message ? error.message : fallback;
  await showToast(message, 'warn');
};
