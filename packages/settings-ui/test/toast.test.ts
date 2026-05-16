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

    const pending = showToast('Daily budget updated.', 'ok', {
      action: { label: 'Undo', onClick },
    });

    expect(toastEl.classList.contains('show')).toBe(true);
    expect(toastEl.textContent).toContain('Daily budget updated.');
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

  it('uses the fallback message for Homey API transport errors', async () => {
    const toastEl = setupDom();
    const { showToastError } = await import('../src/ui/toast.ts');
    let pending = showToastError(
      new Error('Homey api POST /ui_refresh_prices failed: Missing app ID'),
      'Failed to refresh spot prices. If this keeps happening, send a diagnostics report.',
    );

    expect(toastEl.textContent).toContain('Failed to refresh spot prices.');
    expect(toastEl.textContent).toContain('send a diagnostics report');
    expect(toastEl.textContent).not.toContain('/ui_refresh_prices');
    expect(toastEl.textContent).not.toContain('app ID');

    await vi.runAllTimersAsync();
    await pending;

    pending = showToastError(
      new Error('Cannot POST /api/app/com.barelysufficient.pels/ui_refresh_prices'),
      'Failed to refresh spot prices. If this keeps happening, send a diagnostics report.',
    );

    expect(toastEl.textContent).toContain('Failed to refresh spot prices.');
    expect(toastEl.textContent).not.toContain('/api/app/');

    await vi.runAllTimersAsync();
    await pending;

    pending = showToastError(
      new Error('Homey SDK not ready'),
      'Failed to refresh spot prices. If this keeps happening, send a diagnostics report.',
    );

    expect(toastEl.textContent).toContain('Failed to refresh spot prices.');
    expect(toastEl.textContent).not.toContain('Homey SDK');

    await vi.runAllTimersAsync();
    await pending;

    pending = showToastError(
      new Error('Homey api POST /ui_refresh_prices not available'),
      'Failed to refresh spot prices. If this keeps happening, send a diagnostics report.',
    );

    expect(toastEl.textContent).toContain('Failed to refresh spot prices.');
    expect(toastEl.textContent).not.toContain('/ui_refresh_prices');
    expect(toastEl.textContent).not.toContain('not available');

    await vi.runAllTimersAsync();
    await pending;
  });

  it('keeps local validation messages visible', async () => {
    const toastEl = setupDom();
    const { showToastError } = await import('../src/ui/toast.ts');
    let pending = showToastError(
      new Error('Provider surcharge must be between -100 and 100 øre.'),
      'Failed to save price settings.',
    );

    expect(toastEl.textContent).toContain('Provider surcharge must be between -100 and 100 øre.');

    await vi.runAllTimersAsync();
    await pending;

    pending = showToastError(
      new Error('Homey api POST /daily_budget failed: Daily budget must be at least 1 kWh.'),
      'Failed to apply daily budget changes.',
    );

    expect(toastEl.textContent).toContain('Daily budget must be at least 1 kWh.');
    expect(toastEl.textContent).not.toContain('Failed to apply daily budget changes.');

    await vi.runAllTimersAsync();
    await pending;

    pending = showToastError(
      new Error(
        'Homey api POST /ui_refresh_prices failed: PELS_APP_NOT_READY: Refresh prices unavailable while PELS is starting',
      ),
      'Failed to refresh spot prices.',
    );

    // App-not-ready errors are surfaced as the user-friendly "starting" message
    // — never the sentinel prefix and never the caller's specific fallback.
    expect(toastEl.textContent).toContain('PELS is still starting');
    expect(toastEl.textContent).not.toContain('PELS_APP_NOT_READY');
    expect(toastEl.textContent).not.toContain('Failed to refresh spot prices.');

    await vi.runAllTimersAsync();
    await pending;
  });

  it('strips the Homey api transport envelope so users see the server message verbatim', async () => {
    const toastEl = setupDom();
    const { showToastError } = await import('../src/ui/toast.ts');
    const pending = showToastError(
      new Error('Homey api POST /capacity_limit_kw failed: Safety margin cannot exceed the hard cap.'),
      'Failed to save limits and safety settings.',
    );

    expect(toastEl.textContent).toContain('Safety margin cannot exceed the hard cap.');
    expect(toastEl.textContent).not.toContain('Homey api');
    expect(toastEl.textContent).not.toContain('failed:');
    expect(toastEl.textContent).not.toContain('/capacity_limit_kw');

    await vi.runAllTimersAsync();
    await pending;
  });

  it('renders a generic save-failed message when both error and fallback are empty', async () => {
    const toastEl = setupDom();
    const { showToastError } = await import('../src/ui/toast.ts');
    const pending = showToastError(new Error(''), '');

    expect(toastEl.textContent?.trim()).not.toBe('');
    expect(toastEl.textContent).toContain('Save failed');

    await vi.runAllTimersAsync();
    await pending;
  });

  it('falls back when the error is a non-Error value', async () => {
    const toastEl = setupDom();
    const { showToastError } = await import('../src/ui/toast.ts');
    const pending = showToastError(undefined, 'Failed to save limits and safety settings.');

    expect(toastEl.textContent).toContain('Failed to save limits and safety settings.');

    await vi.runAllTimersAsync();
    await pending;
  });

  it('keeps error toasts visible long enough to read', async () => {
    const toastEl = setupDom();
    const { showToastError } = await import('../src/ui/toast.ts');
    const pending = showToastError(
      new Error('Safety margin cannot exceed the hard cap.'),
      'Failed to save limits and safety settings.',
    );

    await vi.advanceTimersByTimeAsync(2500);
    expect(toastEl.classList.contains('show')).toBe(true);

    await vi.runAllTimersAsync();
    await pending;
    expect(toastEl.classList.contains('show')).toBe(false);
  });
});
