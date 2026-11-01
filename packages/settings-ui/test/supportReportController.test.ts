import { describe, expect, it, vi } from 'vitest';
import type { SupportReportResponse } from '../../contracts/src/supportReport';
import { SupportReportController, type SupportReportApi } from '../src/ui/supportReportController';
import { REPORT_EXPIRED_UNCERTAIN, type SupportReportViewState } from '../src/ui/supportReportModel';
import { supportReportFixture } from './helpers/supportReportFixture';

const setup = () => {
  const report = supportReportFixture();
  const api: SupportReportApi = {
    prepare: vi.fn().mockResolvedValue({ ok: true, report }),
    send: vi.fn().mockResolvedValue({ ok: true, report: { ...report, submission: { state: 'sent', reference: 'homey-1' } } }),
    get: vi.fn().mockResolvedValue({ ok: true, report: { ...report, submission: { state: 'sent', reference: 'homey-1' } } }),
  };
  let shown: SupportReportViewState;
  const controller = new SupportReportController(api, (state) => { shown = state; });
  controller.show();
  const current = (): SupportReportViewState => shown;
  controller.edit({ ...current().draft, problem: report.document.request.problem });
  return { api, controller, current, report };
};

describe('support report controller', () => {
  it('sends the description in one step: prepares the report, then sends that report', async () => {
    const { controller, api, current } = setup();
    await controller.submit();
    expect(api.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ problem: 'The heater stayed off.' }));
    expect(api.send).toHaveBeenCalledExactlyOnceWith('report-1');
    expect(current().report?.submission).toEqual({ state: 'sent', reference: 'homey-1' });
    expect(current().operation).toBe('idle');
  });

  it('asks for a description before sending anything', async () => {
    const { controller, api, current } = setup();
    controller.edit({ ...current().draft, problem: '  ' });
    await controller.submit();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(current().notice).toBe('Describe what happened before sending the report.');
  });

  it('starts a device support request blank, but keeps an unsent problem between devices', () => {
    const { controller, current } = setup();
    controller.selectContext({ kind: 'device', homeId: 'main', deviceId: 'other-heater' });
    expect(current().draft.problem).toBe('The heater stayed off.');
    controller.selectContext({ kind: 'device_support', homeId: 'main', deviceId: 'relay' });
    expect(current().draft).toMatchObject({
      subject: { kind: 'device_support', deviceId: 'relay' }, problem: '', expected: '', when: 'now',
    });
  });

  it('asks for a device description before sending a support request', async () => {
    const { controller, api, current } = setup();
    controller.selectContext({ kind: 'device_support', homeId: 'main', deviceId: 'relay' });
    await controller.submit();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(current().notice).toBe('Describe the device before sending the request.');
  });

  it('ignores a second send and edits while a send is in flight', async () => {
    const { controller, api, current, report } = setup();
    let finish!: (response: SupportReportResponse) => void;
    vi.mocked(api.send).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const sending = controller.submit();
    await vi.waitFor(() => expect(api.send).toHaveBeenCalled());
    await controller.submit();
    controller.edit({ ...current().draft, problem: 'Changed while sending' });
    expect(current().report?.submission.state).toBe('sending');
    expect(current().draft.problem).toBe('The heater stayed off.');
    finish({ ok: true, report: { ...report, submission: { state: 'sent', reference: 'homey-1' } } });
    await sending;
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledExactlyOnceWith('report-1');
    expect(current().report?.submission).toEqual({ state: 'sent', reference: 'homey-1' });
  });

  it('keeps a report it cannot send so it can be copied, and drops it once the description changes', async () => {
    const { controller, api, current, report } = setup();
    vi.mocked(api.prepare).mockResolvedValue({ ok: true, report: { ...report, availability: 'app_store_required' } });
    await controller.submit();
    expect(api.send).not.toHaveBeenCalled();
    expect(current().report?.submission.state).toBe('draft');
    expect(current().notice).toBe('Sending requires an App Store installation. You can copy the report instead.');
    controller.edit({ ...current().draft, problem: 'The heater resumed late.' });
    expect(current().report).toBeNull();
  });

  it('keeps a refused report for copying and prepares a new one when sent again', async () => {
    const { controller, api, current, report } = setup();
    vi.mocked(api.send).mockResolvedValueOnce({ ok: true, report: { ...report, submission: { state: 'failed' } } });
    await controller.submit();
    expect(current().report?.submission.state).toBe('failed');
    expect(current().notice).toContain('Homey refused the report');
    await controller.submit();
    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(current().report?.submission.state).toBe('sent');
  });

  it('keeps the prepared report for copying when Homey refuses the send itself', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.send).mockResolvedValueOnce({ ok: false, code: 'sender_unavailable' });
    await controller.submit();
    expect(current().report?.submission.state).toBe('draft');
    expect(current().report?.document.id).toBe('report-1');
    expect(current().notice).toBe('Homey’s reporting service is unavailable. You can copy the report instead.');
  });

  it('keeps the report it could not send when sending again cannot prepare a new one', async () => {
    const { controller, api, current, report } = setup();
    vi.mocked(api.prepare).mockResolvedValueOnce({ ok: true, report: { ...report, availability: 'unavailable' } });
    await controller.submit();
    vi.mocked(api.prepare).mockRejectedValueOnce(new Error('Connection lost'));
    await controller.submit();
    expect(current().report?.document.id).toBe('report-1');
    expect(current().notice).toContain('Could not prepare the report');
  });

  it('keeps the incident time of a report that expires before its outcome is checked', async () => {
    const { controller, api, current, report } = setup();
    vi.mocked(api.send).mockRejectedValueOnce(new Error('Network request failed'));
    vi.mocked(api.get).mockResolvedValueOnce({ ok: false, code: 'report_expired' });
    await controller.submit();
    await controller.check();
    expect(current().report).toBeNull();
    expect(current().notice).toBe(REPORT_EXPIRED_UNCERTAIN);
    expect(current().draft).toMatchObject({
      when: 'custom', atMs: report.document.request.occurredAtMs, problem: report.document.request.problem,
    });
    await controller.submit();
    expect(api.prepare).toHaveBeenLastCalledWith(expect.objectContaining({
      occurredAtMs: report.document.request.occurredAtMs,
    }));
  });

  it('preserves an uncertain submission and checks its outcome without posting again', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.send).mockRejectedValue(new Error('Network request failed'));
    await controller.submit();
    expect(current().report?.submission.state).toBe('unknown');
    await controller.submit();
    await controller.check();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledExactlyOnceWith('report-1');
    expect(current().report?.submission.state).toBe('sent');
  });

  it('retains the description when the report cannot be prepared', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.prepare).mockRejectedValue(new Error('History unavailable'));
    await controller.submit();
    controller.show();
    expect(current().draft.problem).toBe('The heater stayed off.');
    expect(current().notice).toContain('description is kept');
    expect(current().report).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('restores a prepared report by identifier without sending it', async () => {
    const { controller, api, current, report } = setup();
    await controller.restore('report-1');
    expect(current().draft.problem).toBe(report.document.request.problem);
    expect(current().draft.subject).toEqual(report.document.request.subject);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
  });

  it('keeps the latest restore target when an older request finishes later', async () => {
    const { controller, api, current, report } = setup();
    let finishFirst!: (response: SupportReportResponse) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    const first = controller.restore('report-old');
    expect(current().recoveryId).toBe('report-old');
    await controller.restore('report-1');
    finishFirst({ ok: true, report: { ...report, document: { ...report.document, id: 'report-old' } } });
    await first;
    expect(current().report?.document.id).toBe('report-1');
    expect(current().recoveryId).toBeNull();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('asks for the description again when the report it reopens is gone', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.get).mockResolvedValueOnce({ ok: false, code: 'report_expired' });
    await controller.restore('report-gone');
    expect(current().notice).toBe('PELS no longer has this report and cannot tell whether it was sent. '
      + 'If it was not, start another report and describe the problem again.');
  });

  it('retains a failed recovery identifier until a status check succeeds', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Connection lost'));
    await controller.restore('report-1');
    expect(current().recoveryId).toBe('report-1');
    await controller.submit();
    expect(api.prepare).not.toHaveBeenCalled();
    await controller.check();
    expect(current().recoveryId).toBeNull();
    expect(current().report?.document.id).toBe('report-1');
  });

  it('keeps a device and selected incident time when opened from activity', async () => {
    const { controller, api, current } = setup();
    controller.selectContext({ kind: 'device', homeId: 'area-1', deviceId: 'heater' }, 1700000000123);
    controller.edit({ ...current().draft, historyWindow: 'day' });
    await controller.submit();
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({
      subject: { kind: 'device', homeId: 'area-1', deviceId: 'heater' },
      occurredAtMs: 1700000000123,
      historyWindow: 'day',
    }));
  });

  it('starts a new report from another device after a sent one', async () => {
    const { controller, current } = setup();
    await controller.submit();
    expect(current().report?.submission.state).toBe('sent');
    controller.selectContext({ kind: 'device', homeId: 'main', deviceId: 'boiler' }, 1700000000456);
    expect(current().notice).toBe('');
    expect(current().report).toBeNull();
    expect(current().draft).toMatchObject({
      subject: { kind: 'device', homeId: 'main', deviceId: 'boiler' }, when: 'custom', atMs: 1700000000456,
      problem: '', expected: '',
    });
  });

  it('starts a new report when the page is reopened after a sent one, but keeps an unsettled one', async () => {
    const { controller, api, current } = setup();
    await controller.submit();
    controller.leaveSentReport();
    expect(current().report).toBeNull();
    expect(current().draft.problem).toBe('');
    controller.edit({ ...current().draft, problem: 'The boiler stopped.' });
    vi.mocked(api.send).mockRejectedValueOnce(new Error('Network request failed'));
    await controller.submit();
    controller.leaveSentReport();
    expect(current().report?.submission.state).toBe('unknown');
  });
});
