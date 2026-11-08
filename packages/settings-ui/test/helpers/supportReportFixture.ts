import type { PreparedSupportReport } from '../../../contracts/src/supportReport';

export const supportReportFixture = (): PreparedSupportReport => ({
  document: {
    id: 'report-1', subjectName: 'Hall heater',
    request: {
      subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
      problem: 'The heater stayed off.', expected: 'I expected the room to warm up.',
      occurredAtMs: 1700000000000, historyWindow: 'incident',
    },
  },
  message: 'PELS PROBLEM REPORT V2\nType: owner, device\nDescription: The heater stayed off.\nData (gzip, base64):\nH4sIAAAA\nEND PELS REPORT report-1',
  expiresAtMs: 1700001000000, availability: 'available', submission: { state: 'draft' },
});
