import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreparedSupportReport } from '../../contracts/src/supportReport';
import { renderSupportReportView, type SupportReportActions } from '../src/ui/views/SupportReportView';
import { newReportDraft, type SupportReportViewState } from '../src/ui/supportReportModel';
import { supportReportFixture } from './helpers/supportReportFixture';

const GENERAL_FORUMS = [{ url: 'https://community.homey.app/t/147496', label: 'PELS forum thread' }];

const mount = (report: PreparedSupportReport | null = null, forums = GENERAL_FORUMS) => {
  const surface = document.createElement('div');
  document.body.append(surface);
  const state: SupportReportViewState = {
    draft: newReportDraft({ kind: 'device', homeId: 'main', deviceId: 'heater' }),
    devices: [{ id: 'heater', name: 'Hall heater', homeId: 'main' }], devicesUnavailable: false,
    report, recoveryId: null, operation: 'idle', notice: '',
  };
  const actions: SupportReportActions = {
    edit: vi.fn(), submit: vi.fn(), check: vi.fn(), startAnother: vi.fn(), notice: vi.fn(),
  };
  renderSupportReportView(surface, {
    state, actions, homeName: 'Main home', backTarget: 'activity', supportDevice: null, forums,
  });
  return { surface, actions };
};

const NORWAY_FORUMS = [
  { url: 'https://community.homey.app/t/153359', label: 'Norwegian PELS thread' },
  { url: 'https://community.homey.app/t/147496', label: 'PELS forum thread' },
];

const mountSupportRequest = (report: PreparedSupportReport | null = null) => {
  const surface = document.createElement('div');
  document.body.append(surface);
  const state: SupportReportViewState = {
    draft: newReportDraft({ kind: 'device_support', homeId: 'main', deviceId: 'relay' }),
    devices: [], devicesUnavailable: false, report, recoveryId: null, operation: 'idle', notice: '',
  };
  const actions: SupportReportActions = {
    edit: vi.fn(), submit: vi.fn(), check: vi.fn(), startAnother: vi.fn(), notice: vi.fn(),
  };
  renderSupportReportView(surface, {
    state, actions, homeName: 'Main home', backTarget: 'device-support',
    supportDevice: { name: 'Water heater relay' }, forums: NORWAY_FORUMS,
  });
  return { surface, actions };
};

afterEach(() => { render(null, document.body); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('support report view', () => {
  it('shows the description form with one send action and says where the report goes', () => {
    const { surface } = mount();
    expect(surface.querySelector('[data-report-field="problem"]')).not.toBeNull();
    expect(surface.querySelector('[data-report-action="send"]')?.textContent).toBe('Send report');
    expect(surface.querySelector('[data-report-action="preview"]')).toBeNull();
    expect(surface.textContent).toContain('Sent to the PELS developer through Homey, with the app’s logs.');
    expect(surface.querySelector('.pels-appbar__back')?.getAttribute('data-settings-target')).toBe('activity');
  });

  it('links a problem report to the automatic reports, but not a device support request', () => {
    const automatic = mount().surface.querySelector('[data-report-action="automatic"]');
    expect(automatic?.getAttribute('data-settings-target')).toBe('advanced');
    expect(automatic?.getAttribute('data-settings-anchor')).toBe('#advanced-diagnostics-reports');
    render(null, document.body);
    document.body.innerHTML = '';
    const { surface } = mountSupportRequest();
    expect(surface.querySelector('[data-report-action="automatic"]')).toBeNull();
    expect(surface.textContent).not.toContain('PELS can also send reports by itself');
  });

  it('offers copying a report that cannot be sent without showing its contents', () => {
    const { surface } = mount({ ...supportReportFixture(), availability: 'app_store_required' });
    expect(surface.querySelector('[data-report-action="copy"]')).not.toBeNull();
    expect(surface.querySelector('[data-report-field="problem"]')).not.toBeNull();
    expect(surface.textContent).not.toContain('PELS PROBLEM REPORT');
    expect(surface.querySelectorAll('[data-report-device-id]')).toHaveLength(0);
    expect(surface.querySelector('textarea')).toBeNull();
  });

  it('offers copying a prepared report that Homey refused to send', () => {
    const { surface } = mount({ ...supportReportFixture(), availability: 'available' });
    expect(surface.querySelector('[data-report-action="copy"]')).not.toBeNull();
    expect(surface.querySelector('[data-report-field="problem"]')).not.toBeNull();
  });

  it('offers checking rather than another send for an uncertain outcome', () => {
    const { surface, actions } = mount({ ...supportReportFixture(), submission: { state: 'unknown' } });
    expect(surface.querySelector('[data-report-action="send"]')).toBeNull();
    expect(surface.textContent).toContain('PELS reference: report-1');
    surface.querySelector<HTMLElement>('[data-report-action="check"]')?.click();
    expect(actions.check).toHaveBeenCalledTimes(1);
  });

  it('confirms a sent report with its reference and where to follow up', () => {
    const { surface } = mount({ ...supportReportFixture(), submission: { state: 'sent', reference: '' } });
    expect(surface.textContent).toContain('Reference: report-1');
    const forum = surface.querySelector<HTMLAnchorElement>('a[target="_blank"]');
    expect(forum?.getAttribute('href')).toBe('https://community.homey.app/t/147496');
    expect(surface.textContent).toContain('To hear back');
    const email = new URL(surface.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')?.href ?? '');
    expect(email.searchParams.get('subject')).toBe('PELS: Hall heater');
    expect(email.searchParams.get('body')).toBe('The heater stayed off.\n\nReport reference: report-1');
    expect(surface.textContent).not.toContain('quote the reference');
    expect(surface.querySelector('[data-report-action="done"]')?.getAttribute('data-settings-target')).toBe('activity');
    expect(surface.querySelector('[data-report-field="problem"]')).toBeNull();
  });

  it('offers the same country-aware follow-up for an ordinary report', () => {
    const { surface } = mount({ ...supportReportFixture(), submission: { state: 'sent', reference: 'ref-9' } }, NORWAY_FORUMS);
    const links = [...surface.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.slice(0, 2).map((link) => link.href)).toEqual(NORWAY_FORUMS.map((forum) => forum.url));
    expect(links[2].href).toContain('mailto:olemarkus@gmail.com');
    expect(new URL(links[2].href).searchParams.get('body')).toContain('Report reference: ref-9');
  });

  it('shows the report text for manual copying only when the clipboard fails', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Unavailable')) },
    });
    try {
      const { surface, actions } = mount({ ...supportReportFixture(), submission: { state: 'failed' } });
      surface.querySelector<HTMLElement>('[data-report-action="copy"]')?.click();
      await vi.waitFor(() => expect(actions.notice).toHaveBeenCalledWith('Select and copy the report text below.'));
      await vi.waitFor(() => expect(surface.querySelector('textarea')?.value).toBe(supportReportFixture().message));
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('asks one question about a device PELS does not support, with one send action', () => {
    const { surface } = mountSupportRequest();
    expect(surface.querySelector('.pels-appbar__title')?.textContent).toBe('Device support');
    expect(surface.querySelector('[data-report-device-name]')?.textContent).toBe('Water heater relay');
    const comment = surface.querySelector<HTMLElement & { label?: string }>('[data-report-field="problem"]');
    expect(comment?.label ?? comment?.getAttribute('label')).toBe('Describe the device');
    for (const field of ['device', 'expected', 'when', 'history']) {
      expect(surface.querySelector(`[data-report-field="${field}"]`)).toBeNull();
    }
    expect(surface.querySelector('[data-report-action="send"]')?.textContent).toBe('Send request');
    expect(surface.querySelectorAll('form')).toHaveLength(1);
    expect(surface.querySelectorAll('[data-report-action="send"]')).toHaveLength(1);
    expect(surface.querySelector('[data-report-action="preview"]')).toBeNull();
    expect(surface.querySelector('a')).toBeNull();
  });

  it('confirms a sent request without promising support', () => {
    const { surface } = mountSupportRequest({ ...supportReportFixture(), submission: { state: 'sent', reference: 'ref-9' } });
    expect(surface.textContent).toContain('Request sent');
    expect(surface.textContent).toContain('Reference: ref-9');
    expect(surface.textContent).toContain('within 1–2 days, depending on how complex the device is.');
    expect(surface.textContent).toContain('To hear back');
    const links = [...surface.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.slice(0, 2).map((link) => link.href)).toEqual(NORWAY_FORUMS.map((forum) => forum.url));
    const email = new URL(links[2].href);
    expect(email.searchParams.get('body')).toContain('Report reference: ref-9');
    expect(surface.textContent).not.toContain('quote the reference');
    expect(surface.querySelector('[data-report-action="done"]')?.getAttribute('data-settings-target')).toBe('device-support');
  });
});
