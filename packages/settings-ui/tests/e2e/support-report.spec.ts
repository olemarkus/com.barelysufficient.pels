import type { PreparedSupportReport, SupportReportRequest } from '../../../contracts/src/supportReport';
import { supportReportFixture } from '../../test/helpers/supportReportFixture';
import { expect, test, injectHomeyHostCss, type Page } from './fixtures/test';
import { readMdSelectHeadlineText, readMdValue, setMdValue } from './fixtures/materialWeb';

type ReportStubWindow = Window & {
  __PELS_HOMEY_STUB__?: { apiHandlers: Record<string, (body: unknown) => unknown> };
  reportRequests: SupportReportRequest[];
  reportSends: unknown[];
  reportChecks: number;
};

const installReportStub = async (page: Page, uncertain = false, expired = false): Promise<void> => {
  await page.addInitScript(({ templateJson, loseResponse, expireOnSend }) => {
    const template = JSON.parse(templateJson) as PreparedSupportReport;
    const stub = window as unknown as ReportStubWindow;
    stub.reportRequests = [];
    stub.reportSends = [];
    stub.reportChecks = 0;
    let report: PreparedSupportReport = template;
    stub.__PELS_HOMEY_STUB__ = { apiHandlers: {
      'GET /ui_device_log': () => ({
        version: 2, entries: template.document.activity.state === 'available' ? template.document.activity.entries : [],
        retentionDays: 7, maxEntries: 1000, maxEntriesPerDevice: 100, persistence: 'stored',
      }),
      'POST /support-report/prepare': (body) => {
        const request = body as SupportReportRequest;
        stub.reportRequests.push(request);
        report = { ...template, document: { ...template.document, request },
          message: `PELS PROBLEM REPORT V1\n${JSON.stringify(request)}\nEND PELS REPORT report-1` };
        return { ok: true, report };
      },
      'POST /support-report/report-1/send': (body) => {
        stub.reportSends.push(body);
        if (expireOnSend) return { ok: false, code: 'report_expired' };
        report = { ...report, submission: { state: 'sent', reference: 'homey-receipt-1' } };
        if (loseResponse) throw new Error('Connection lost after dispatch');
        return { ok: true, report };
      },
      'GET /support-report/report-1': () => {
        stub.reportChecks += 1;
        return { ok: true, report: { ...report, submission: { state: 'sent', reference: 'homey-receipt-1' } } };
      },
    } };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: () => Promise.reject(new Error('Clipboard unavailable')) },
    });
  }, { templateJson: JSON.stringify(supportReportFixture()), loseResponse: uncertain, expireOnSend: expired });
};

test('keeps a draft through Back, sends it in one step, and starts fresh after Done', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1100 });
  await injectHomeyHostCss(page);
  await installReportStub(page);
  await page.goto('/?page=settings');
  await page.locator('.settings-nav-card[data-settings-target="report-problem"]').click();
  const panel = page.locator('#report-problem-panel');
  await expect(panel).toBeVisible();
  await expect.poll(() => readMdSelectHeadlineText(page, '[data-report-field="device"]')).toBe('App or several devices');
  await setMdValue(page, '[data-report-field="problem"]', 'The heater stayed off.');
  await setMdValue(page, '[data-report-field="expected"]', 'I expected it to resume.');
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator('.settings-nav-card[data-settings-target="report-problem"]').click();
  await expect.poll(() => readMdValue(page, '[data-report-field="problem"]')).toBe('The heater stayed off.');
  await panel.locator('[data-report-action="send"]').click();
  await expect(panel.getByRole('heading', { name: 'Report sent' })).toBeInViewport();
  await expect(panel).toContainText('homey-receipt-1');
  await expect(panel.locator('[data-report-field="problem"]')).toHaveCount(0);
  await expect(panel).not.toContainText('PELS PROBLEM REPORT');
  const stub = () => page.evaluate(() => {
    const report = window as unknown as ReportStubWindow;
    return { requests: report.reportRequests, sends: report.reportSends };
  });
  expect((await stub()).requests.map((request) => request.problem)).toEqual(['The heater stayed off.']);
  expect((await stub()).sends).toEqual([{ consent: true }]);
  expect(page.url()).not.toContain('heater');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('heater stayed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.locator('[data-report-action="done"]').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.locator('.settings-nav-card[data-settings-target="report-problem"]').click();
  await expect.poll(() => readMdValue(page, '[data-report-field="problem"]')).toBe('');
  await expect(panel.getByRole('heading', { name: 'Report sent' })).toHaveCount(0);
});
test('checks an uncertain send without another submission and restores status after reload', async ({ page }) => {
  await installReportStub(page, true);
  await page.goto('/?page=settings/report-problem');
  const panel = page.locator('#report-problem-panel');
  await setMdValue(page, '[data-report-field="problem"]', 'The device stopped.');
  await panel.locator('[data-report-action="send"]').click();
  await expect(panel).toContainText('Submission could not be confirmed');
  await expect(panel.locator('[data-report-action="send"]')).toHaveCount(0);
  await panel.locator('[data-report-action="check"]').click();
  await expect(panel).toContainText('homey-receipt-1');
  expect(await page.evaluate(() => (window as unknown as ReportStubWindow).reportSends)).toHaveLength(1);
  await page.reload();
  await expect(panel).toContainText('homey-receipt-1');
  expect(await page.evaluate(() => (window as unknown as ReportStubWindow).reportChecks)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as ReportStubWindow).reportSends)).toHaveLength(0);
});

test('keeps the description when the prepared report expires before it is sent', async ({ page }) => {
  await installReportStub(page, false, true);
  await page.goto('/?page=settings/report-problem');
  const panel = page.locator('#report-problem-panel');
  await setMdValue(page, '[data-report-field="problem"]', 'The device stopped.');
  await panel.locator('[data-report-action="send"]').click();
  await expect(panel).toContainText('The report expired before it was sent');
  await expect(panel.locator('[data-report-action="send"]')).toBeEnabled();
  await expect.poll(() => readMdValue(page, '[data-report-field="problem"]')).toBe('The device stopped.');
  expect(new URL(page.url()).searchParams.has('reportId')).toBe(false);
  await panel.locator('[data-report-action="send"]').click();
  const readRequests = () => page.evaluate(() => (window as unknown as ReportStubWindow).reportRequests);
  await expect.poll(async () => (await readRequests()).length).toBe(2);
});
test('keeps the latest navigation target when a previous report loads late', async ({ page }) => {
  await installReportStub(page);
  await page.goto('/?page=settings');
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.evaluate(() => {
    const stub = window as unknown as ReportStubWindow;
    const handlers = stub.__PELS_HOMEY_STUB__!.apiHandlers;
    handlers['GET /support-report/report-old'] = () => new Promise((resolve) => {
      window.addEventListener('finish-old-report', () => resolve({
        ok: false, code: 'report_expired',
      }), { once: true });
    });
    window.history.pushState({}, '', '/?page=settings/report-problem&reportId=report-old');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  const panel = page.locator('#report-problem-panel');
  await expect(panel).toContainText('Loading your report');
  await page.evaluate(() => {
    window.history.pushState({}, '', '/?page=settings/report-problem&reportId=report-1');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(panel).toContainText('homey-receipt-1');
  await page.evaluate(() => window.dispatchEvent(new Event('finish-old-report')));
  await expect(panel).toContainText('homey-receipt-1');
  expect(new URL(page.url()).searchParams.get('reportId')).toBe('report-1');
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.settings-nav-card[data-settings-target="report-problem"]').click();
  await expect.poll(() => readMdValue(page, '[data-report-field="device"]')).toBe('device:heater');
  await expect.poll(() => readMdValue(page, '[data-report-field="problem"]')).toBe('');
});

test('opens an activity incident at its exact time and renders the form and result at narrow widths in both themes', async ({ browser, browserName, baseURL }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Touch emulation uses Chromium');
  for (const width of [320, 480]) {
    for (const dark of [false, true]) {
      const context = await browser.newContext({
        baseURL, viewport: { width, height: 3000 }, isMobile: dark, hasTouch: dark,
      });
      try {
        const page = await context.newPage();
        await injectHomeyHostCss(page);
        await installReportStub(page);
        await page.goto('/?page=settings/activity');
        await page.locator('#activity-panel [data-report-device-id="heater"]').click();
        const panel = page.locator('#report-problem-panel');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText('Time zone:');
        await expect.poll(() => readMdSelectHeadlineText(page, '[data-report-field="device"]')).toBe('Hall heater (recorded)');
        await panel.locator('[data-report-field="problem"] textarea').fill('The heater stayed off.');
        await panel.locator('[data-report-field="expected"] textarea').fill('I expected the room to warm up.');
        await panel.getByRole('heading', { name: 'Report a problem', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(dark);
        await page.screenshot({ path: testInfo.outputPath(`form-${width}-${dark ? 'dark' : 'light'}.png`) });
        await panel.locator('[data-report-action="send"]').click();
        await expect(panel).toContainText('homey-receipt-1');
        const requests = await page.evaluate(() => (window as unknown as ReportStubWindow).reportRequests);
        expect(requests[0].subject).toEqual({ kind: 'device', homeId: 'main', deviceId: 'heater' });
        expect(requests[0].occurredAtMs).toBe(1700000000000);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`sent-${width}-${dark ? 'dark' : 'light'}.png`) });
        await panel.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(page.locator('#activity-panel')).toBeVisible();
      } finally {
        await context.close();
      }
    }
  }
});
