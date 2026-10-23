import type Homey from 'homey';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';
import { createFlowBackedDeviceState } from '../../setup/flowBackedCardAccess';
import { SettingsRepository } from '../../setup/settingsRepository';
import { FLOW_REPORTED_DEVICE_CAPABILITIES } from '../../lib/utils/settingsKeys';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { FlowReportedCapabilitiesByDevice } from '../../lib/device/transport/flowReportedCapabilities';
import { testLogger } from '../utils/testLogger';

const savedReports: FlowReportedCapabilitiesByDevice = {
  heater: { onoff: { value: true, reportedAt: 1_700_000_000_000, source: 'flow' } },
};

describe('Flow capability persistence reads', () => {
  let reports: FlowReportedCapabilitiesByDevice;
  let timers: TimerRegistry;
  let repository: SettingsRepository;

  const buildFlowBacked = () => createFlowBackedDeviceState(
    mockHomeyInstance as unknown as Homey.App['homey'], {
      persistence: repository,
      getStructuredLogger: () => testLogger,
      getFlowReportedCapabilities: () => reports,
      setFlowReportedCapabilities: (state) => { reports = state; },
      getDeviceManager: () => undefined,
      getDeviceConfiguration: () => [],
      resolveManagedState: () => true,
      getSteppedLoadProfile: () => undefined,
      getExpectedPowerKwOverrides: () => ({}),
      getLearnedPowerPeaks: () => ({}),
      timers,
      syncHeadroomUsageObservation: () => {},
    },
  );

  beforeEach(() => {
    resetMockHomey();
    mockHomeyInstance.settings.set('unrelated_key', true);
    reports = {};
    timers = new TimerRegistry();
    repository = new SettingsRepository(mockHomeyInstance as unknown as Homey.App['homey']);
  });

  afterEach(() => {
    timers.clearAll();
    vi.restoreAllMocks();
  });

  it('resolves a never-written setting from a healthy key list without writing it', () => {
    const set = vi.spyOn(mockHomeyInstance.settings, 'set');
    expect(repository.loadFlowReportedCapabilities()).toEqual({ state: 'resolved', capabilities: {} });
    buildFlowBacked().loadPersistedState();
    expect(reports).toEqual({});
    expect(set).not.toHaveBeenCalled();
  });

  it('adopts an explicitly stored empty map after accepting previous reports', () => {
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, savedReports);
    const flowBacked = buildFlowBacked();
    flowBacked.loadPersistedState();
    expect(reports).toEqual(savedReports);
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, {});

    expect(repository.loadFlowReportedCapabilities()).toEqual({ state: 'resolved', capabilities: {} });
    flowBacked.loadPersistedState();
    expect(reports).toEqual({});
  });

  it('adopts confirmed removal from a healthy key list', () => {
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, savedReports);
    const flowBacked = buildFlowBacked();
    flowBacked.loadPersistedState();
    mockHomeyInstance.settings.unset(FLOW_REPORTED_DEVICE_CAPABILITIES);

    flowBacked.loadPersistedState();
    expect(reports).toEqual({});
  });

  it.each([
    ['undefined value on a listed key', undefined],
    ['null value on a listed key', null],
    ['malformed top-level value', 'bad read'],
    ['array value', []],
    ['malformed device entry', { heater: null }],
    ['malformed capability entry', { heater: { onoff: { value: 'on', source: 'flow', reportedAt: 42 } } }],
  ])('preserves accepted reports on %s and recovers on a later read', (_label, raw) => {
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, savedReports);
    const flowBacked = buildFlowBacked();
    flowBacked.loadPersistedState();
    const accepted = reports;
    const get = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    const flakyGet = vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => (
      key === FLOW_REPORTED_DEVICE_CAPABILITIES ? raw : get(key)
    ));
    const set = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(repository.loadFlowReportedCapabilities()).toEqual({ state: 'unavailable' });
    expect(() => flowBacked.loadPersistedState()).not.toThrow();
    expect(reports).toBe(accepted);
    expect(set).not.toHaveBeenCalled();

    flakyGet.mockRestore();
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, {});
    flowBacked.loadPersistedState();
    expect(reports).toEqual({});
  });

  it.each(['get', 'getKeys', 'empty key list'] as const)(
    'preserves accepted reports when %s cannot establish persisted state',
    (failure) => {
      mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, savedReports);
      const flowBacked = buildFlowBacked();
      flowBacked.loadPersistedState();
      const accepted = reports;
      if (failure === 'empty key list') {
        vi.spyOn(mockHomeyInstance.settings, 'getKeys').mockReturnValue([]);
      } else {
        vi.spyOn(mockHomeyInstance.settings, failure).mockImplementation(() => { throw new Error('SDK unavailable'); });
      }
      const set = vi.spyOn(mockHomeyInstance.settings, 'set');

      expect(repository.loadFlowReportedCapabilities()).toEqual({ state: 'unavailable' });
      expect(() => flowBacked.loadPersistedState()).not.toThrow();
      expect(reports).toBe(accepted);
      expect(set).not.toHaveBeenCalled();
    },
  );
});
