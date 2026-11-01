import type { PreparedSupportReport, SupportReportRequest } from '../../../../contracts/src/supportReport';
import { supportReportFixture } from '../../../test/helpers/supportReportFixture';
import type { Page } from './test';

/** Prepare and send for a device support request, recording each request and send. */
type DeviceSupportStubWindow = Window & {
  __PELS_HOMEY_STUB__?: { apiHandlers: Record<string, (body: unknown) => unknown> };
  reportRequests: SupportReportRequest[];
  reportSends: unknown[];
};

export const installDeviceSupportReportStub = async (page: Page): Promise<void> => {
  await page.addInitScript(({ templateJson }) => {
    const template = JSON.parse(templateJson) as PreparedSupportReport;
    const stub = window as unknown as DeviceSupportStubWindow;
    stub.reportRequests = [];
    stub.reportSends = [];
    let report: PreparedSupportReport = template;
    stub.__PELS_HOMEY_STUB__ = { apiHandlers: {
      'POST /support-report/prepare': (body) => {
        const request = body as SupportReportRequest;
        stub.reportRequests.push(request);
        report = { ...template, document: { ...template.document, request } };
        return { ok: true, report };
      },
      'POST /support-report/report-1/send': (body) => {
        stub.reportSends.push(body);
        report = { ...report, submission: { state: 'sent', reference: 'homey-receipt-1' } };
        return { ok: true, report };
      },
    } };
  }, { templateJson: JSON.stringify(supportReportFixture()) });
};

export const readDeviceSupportStub = (page: Page) => page.evaluate(() => {
  const stub = window as unknown as DeviceSupportStubWindow;
  return { requests: stub.reportRequests, sends: stub.reportSends };
});

