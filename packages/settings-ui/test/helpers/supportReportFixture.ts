import type { PreparedSupportReport } from '../../../contracts/src/supportReport';

export const supportReportFixture = (): PreparedSupportReport => ({
  document: {
    version: 1, id: 'report-1', capturedAtMs: 1700000100000,
    subjectName: 'Hall heater', appVersion: '3.21.0', homeyVersion: '12.5.0',
    request: {
      subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
      problem: 'The heater stayed off.', expected: 'I expected the room to warm up.',
      occurredAtMs: 1700000000000, historyWindow: 'incident',
    },
    activity: {
      state: 'available', entries: [{
        deviceId: 'heater', deviceName: 'Hall heater', atMs: 1700000000000,
        stateMsg: 'Limited', stateKind: 'held', powerMsg: null,
        usageMsg: '18 °C · target 22 °C', statusMsg: 'Waiting for capacity',
      }],
      recordingsStartedAtMs: [1699990000000],
      fromMs: 1699996400000, toMs: 1700000100000, retentionDays: 7,
      maxEntries: 1000, maxEntriesPerDevice: 100, persistence: 'stored', leftOutForSize: 0,
    },
    deviceEvents: {
      state: 'available', entries: [], deviceIds: ['heater'], fromMs: 1699996400000, toMs: 1700000100000,
      retentionDays: 7, maxEntriesPerDevice: 200, leftOut: 0,
    },
    log: {
      state: 'available', lines: [], overflow: [], fromMs: 1699996400000, toMs: 1700000100000, leftOutForSize: 0,
      omittedEvents: [],
    },
    trigger: 'owner',
    sections: [{ title: 'Current device state', values: { powerW: 0 } }], omissions: [],
  },
  message: 'PELS PROBLEM REPORT V1\n{"problem":"The heater stayed off."}\nEND PELS REPORT report-1',
  expiresAtMs: 1700001000000, availability: 'available', submission: { state: 'draft' },
});
