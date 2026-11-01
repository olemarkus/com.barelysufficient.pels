import { afterEach, describe, expect, it, vi } from 'vitest';
import { installHomeyMock, type MockHomeyClient } from './helpers/homeyApiMock.ts';

// Only a device support request names a device PELS may not list, so only it
// reads Homey's full device list. A problem report opens without that read.

const deviceListReads = (homey: MockHomeyClient): number => (
  homey.api.mock.calls.filter(([method, uri]) => method === 'GET' && uri === '/homey_devices').length
);

const openReport = async (search: string) => {
  vi.resetModules();
  window.history.replaceState(null, '', `/?page=settings/report-problem${search}`);
  document.body.innerHTML = '<div id="support-report-root"></div>';
  const homey = installHomeyMock();
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  setHomeyClient(homey as never);
  const { refreshSupportReport } = await import('../src/ui/supportReport.ts');
  await refreshSupportReport();
  return homey;
};

describe('support report device list read', () => {
  afterEach(async () => {
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(null);
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
  });

  it('opens a problem report about the app without reading Homey devices', async () => {
    expect(deviceListReads(await openReport(''))).toBe(0);
  });

  it('reads Homey devices to name the device of a support request', async () => {
    expect(deviceListReads(await openReport('&reportKind=device_support&reportDeviceId=relay'))).toBe(1);
  });
});
