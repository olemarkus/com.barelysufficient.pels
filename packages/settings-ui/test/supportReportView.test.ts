import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderSupportReportView, type SupportReportActions } from '../src/ui/views/SupportReportView';
import { newReportDraft, type SupportReportViewState } from '../src/ui/supportReportModel';
import { supportReportFixture } from './helpers/supportReportFixture';

const mount = (report = supportReportFixture()) => {
  const surface = document.createElement('div');
  document.body.append(surface);
  const state: SupportReportViewState = {
    draft: newReportDraft({ kind: 'device', homeId: 'main', deviceId: 'heater' }),
    devices: [{ id: 'heater', name: 'Hall heater', homeId: 'main' }], devicesUnavailable: false,
    report, recoveryId: null, operation: 'idle', notice: '',
  };
  const actions: SupportReportActions = {
    edit: vi.fn(), editDetails: vi.fn(), prepare: vi.fn(), send: vi.fn(), check: vi.fn(), startAnother: vi.fn(), notice: vi.fn(),
  };
  renderSupportReportView(surface, { state, actions, homeName: 'Main home', backTarget: 'activity' });
  return { surface, actions };
};

afterEach(() => { render(null, document.body); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('support report view', () => {
  it('separates historical activity from the current capture and names the recipient', () => {
    const { surface } = mount();
    expect(surface.textContent).toContain('Current details captured');
    expect(surface.textContent).toContain('Recorded activity retains its original timestamps');
    expect(surface.textContent).toContain('PELS developer through Homey');
    expect(surface.textContent).toContain('logs, which are separate from this preview');
    expect(surface.querySelectorAll('[data-report-device-id]')).toHaveLength(0);
    expect(surface.querySelector('.pels-appbar__back')?.getAttribute('data-settings-target')).toBe('activity');
  });

  it('replaces the form with a preview and an explicit edit action', () => {
    const { surface, actions } = mount();
    expect(surface.querySelector('[data-report-field="problem"]')).toBeNull();
    surface.querySelector<HTMLElement>('[data-report-action="edit"]')?.click();
    expect(actions.editDetails).toHaveBeenCalledTimes(1);
  });

  it('offers copying but disables sending on a local installation', () => {
    const { surface } = mount({ ...supportReportFixture(), availability: 'app_store_required' });
    expect(surface.textContent).toContain('requires an App Store installation');
    expect(surface.querySelector('[data-report-action="copy"]')).not.toBeNull();
    expect(surface.querySelector('[data-report-action="send"]')?.hasAttribute('disabled')).toBe(true);
  });

  it('offers checking rather than another send for an uncertain outcome', () => {
    const { surface, actions } = mount({ ...supportReportFixture(), submission: { state: 'unknown' } });
    expect(surface.querySelector('[data-report-action="send"]')).toBeNull();
    surface.querySelector<HTMLElement>('[data-report-action="check"]')?.click();
    expect(actions.check).toHaveBeenCalledTimes(1);
  });

  it('shows the PELS reference when Homey accepts without returning a reference', () => {
    const { surface } = mount({ ...supportReportFixture(), submission: { state: 'sent', reference: '' } });
    expect(surface.textContent).toContain('PELS reference: report-1');
    expect(surface.querySelector('[data-report-action="done"]')).not.toBeNull();
    expect(surface.querySelector('[data-report-field="problem"]')).toBeNull();
    expect(surface.querySelector('[data-report-action="edit"]')).toBeNull();
    expect(surface.querySelector<HTMLDetailsElement>('[data-report-submitted-details]')?.open).toBe(false);
  });

  it('describes an empty incident window without claiming no activity was recorded', () => {
    const report = supportReportFixture();
    if (report.document.activity.state !== 'available') throw new Error('Expected activity fixture');
    const { surface } = mount({ ...report, document: { ...report.document,
      activity: { ...report.document.activity, entries: [] },
    } });
    expect(surface.textContent).toContain('No retained activity was found for this incident and time window.');
    expect(surface.textContent).not.toContain('No activity recorded yet');
  });

  it('shows missing evidence while retaining a sendable description', () => {
    const report = supportReportFixture();
    const { surface } = mount({ ...report, document: { ...report.document,
      activity: { state: 'unavailable', reason: 'Activity is unavailable for this meter area.' },
      omissions: ['Current device details are unavailable.'],
    } });
    expect(surface.textContent).toContain('Activity is unavailable for this meter area');
    expect(surface.textContent).toContain('Current device details are unavailable');
    expect(surface.querySelector('[data-report-action="send"]')?.hasAttribute('disabled')).toBe(false);
  });

  it('opens and selects the report text when clipboard access fails', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Unavailable')) },
    });
    try {
      const { surface, actions } = mount({ ...supportReportFixture(), submission: { state: 'sent', reference: '' } });
      surface.querySelector<HTMLElement>('[data-report-action="copy"]')?.click();
      await vi.waitFor(() => expect(actions.notice).toHaveBeenCalledWith('Select and copy the report text below.'));
      expect(surface.querySelector<HTMLDetailsElement>('[data-report-details]')?.open).toBe(true);
      expect(surface.querySelector<HTMLDetailsElement>('[data-report-submitted-details]')?.open).toBe(true);
      expect(window.getSelection()?.toString()).toBe(supportReportFixture().message);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
