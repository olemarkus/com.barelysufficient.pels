import type { DeviceJournal } from '../../lib/ports/deviceJournal';

export const ignoredDeviceJournal: DeviceJournal = { record: () => {} };
