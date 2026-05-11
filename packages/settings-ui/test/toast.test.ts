import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setupDom = () => {
  document.body.replaceChildren();
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.append(toast);
  return toast;
};

describe('showToast with action', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders an action button that fires onClick and dismisses the toast', async () => {
    const toastEl = setupDom();
    const { showToast } = await import('../src/ui/toast.ts');
    const onClick = vi.fn();

    const pending = showToast('Daily budget model applied.', 'ok', {
      action: { label: 'Undo', onClick },
    });

    expect(toastEl.classList.contains('show')).toBe(true);
    expect(toastEl.textContent).toContain('Daily budget model applied.');
    const actionButton = toastEl.querySelector<HTMLButtonElement>('.toast__action');
    expect(actionButton).not.toBeNull();
    expect(actionButton?.textContent).toBe('Undo');

    actionButton?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(toastEl.classList.contains('show')).toBe(false);

    await vi.runAllTimersAsync();
    await pending;
    expect(toastEl.classList.contains('show')).toBe(false);
  });

  it('keeps the toast visible longer when an action is offered', async () => {
    const toastEl = setupDom();
    const { showToast } = await import('../src/ui/toast.ts');
    const pending = showToast('msg', 'ok', { action: { label: 'Undo', onClick: () => undefined } });

    await vi.advanceTimersByTimeAsync(2000);
    expect(toastEl.classList.contains('show')).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(toastEl.classList.contains('show')).toBe(false);
  });

  it('preserves the legacy two-arg signature without an action button', async () => {
    const toastEl = setupDom();
    const { showToast } = await import('../src/ui/toast.ts');
    const pending = showToast('hello', 'ok');
    expect(toastEl.querySelector('.toast__action')).toBeNull();
    await vi.runAllTimersAsync();
    await pending;
    expect(toastEl.classList.contains('show')).toBe(false);
  });
});
