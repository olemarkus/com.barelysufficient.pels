import { findDeviceAdapterViolations } from '../../scripts/check-device-adapters.mjs';

test.each([
  "import type { Session } from './tesla/session';",
  "export { adapter } from './easee';",
  "type Adapter = import('./zaptec').Adapter;",
  "const adapter = require('./tesla');",
  "const adapter = import('./tesla');",
  "const current = device.capabilitiesObj.charging_on;",
  "const current = device.capabilitiesObj['measure_charge_current'];",
  "const driver = 'homey:app:com.tesla.car:battery';",
])('rejects downstream integration coupling: %s', (source) => {
  expect(findDeviceAdapterViolations('lib/device/common.ts', source)).not.toEqual([]);
});

test('permits registry entrypoints but rejects internal files and cross-integration imports', () => {
  expect(findDeviceAdapterViolations('lib/device/deviceAdapterRegistry.ts', "import { adapter } from './tesla';")).toEqual([]);
  expect(findDeviceAdapterViolations('lib/device/deviceAdapterRegistry.ts', "import { Session } from './tesla/session';")).not.toEqual([]);
  expect(findDeviceAdapterViolations('lib/device/tesla/index.ts', "import { adapter } from '../easee';")).not.toEqual([]);
});

test('permits private vendor interpretation, internal imports, and explanatory comments', () => {
  expect(findDeviceAdapterViolations('lib/device/tesla/index.ts', "import { Session } from './session'; const value = device.charging_on;")).toEqual([]);
  expect(findDeviceAdapterViolations('lib/device/common.ts', "// Tesla exposes charging_on.\nconst label = 'Car charging';")).toEqual([]);
});


test.each([
  "import type { Plan } from '../../plan/types';",
  "import { observe } from '../../observer/index';",
  "import { resolve } from '../deviceAdapterRegistry';",
  "import type { View } from '../../../packages/settings-ui/src/view';",
])('rejects integration dependencies on downstream consumers: %s', (source) => {
  expect(findDeviceAdapterViolations('lib/device/tesla/index.ts', source)).not.toEqual([]);
});
