import { describe, expect, it, vi } from 'vitest';
import type { SupportReportResponse } from '../../contracts/src/supportReport';
import { SupportReportController, type SupportReportApi } from '../src/ui/supportReportController';
import type { SupportReportViewState } from '../src/ui/supportReportModel';
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
  it('requires a preview and invalidates it when the description changes', async () => {
    const { controller, api, current } = setup();
    await controller.send();
    expect(api.send).not.toHaveBeenCalled();
    await controller.prepare();
    expect(current().report?.document.id).toBe('report-1');
    controller.edit({ ...current().draft, problem: 'The heater resumed late.' });
    expect(current().report).toBeNull();
    await controller.send();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('sends only the reviewed identifier and ignores a second click while in flight', async () => {
    const { controller, api, current, report } = setup();
    let finish!: (response: SupportReportResponse) => void;
    vi.mocked(api.send).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await controller.prepare();
    const sending = controller.send();
    await controller.send();
    controller.edit({ ...current().draft, problem: 'Changed while sending' });
    expect(api.send).toHaveBeenCalledExactlyOnceWith('report-1');
    expect(current().draft.problem).toBe('The heater stayed off.');
    finish({ ok: true, report: { ...report, submission: { state: 'sent', reference: 'homey-1' } } });
    await sending;
    expect(current().report?.submission).toEqual({ state: 'sent', reference: 'homey-1' });
  });

  it('preserves an uncertain submission and checks its outcome without posting again', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.send).mockRejectedValue(new Error('Network request failed'));
    await controller.prepare();
    await controller.send();
    expect(current().report?.submission.state).toBe('unknown');
    expect(current().draft.problem).toBe('The heater stayed off.');
    await controller.send();
    await controller.check();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledExactlyOnceWith('report-1');
    expect(current().report?.submission.state).toBe('sent');
  });

  it('retains the description after preparation fails and when returning to the page', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.prepare).mockRejectedValue(new Error('History unavailable'));
    await controller.prepare();
    controller.show();
    expect(current().draft.problem).toBe('The heater stayed off.');
    expect(current().notice).toContain('description is kept');
    expect(current().report).toBeNull();
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

  it('retains a failed recovery identifier until a status check succeeds', async () => {
    const { controller, api, current } = setup();
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Connection lost'));
    await controller.restore('report-1');
    expect(current().recoveryId).toBe('report-1');
    await controller.prepare();
    expect(api.prepare).not.toHaveBeenCalled();
    await controller.check();
    expect(current().recoveryId).toBeNull();
    expect(current().report?.document.id).toBe('report-1');
  });

  it('keeps a device and selected incident time when opened from activity', async () => {
    const { controller, api, current } = setup();
    controller.selectContext({ kind: 'device', homeId: 'area-1', deviceId: 'heater' }, 1700000000123);
    controller.edit({ ...current().draft, historyWindow: 'day' });
    await controller.prepare();
    expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({
      subject: { kind: 'device', homeId: 'area-1', deviceId: 'heater' },
      occurredAtMs: 1700000000123,
      historyWindow: 'day',
    }));
  });
});
