import type { DeviceDescriptor } from '../../../contracts/src/types.ts';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from './planTypes.ts';

/**
 * The device-list carrier the Overview joins on. Widens the shared list item
 * with the two descriptor fields this surface needs and no others: `managed`
 * decides membership, `priority` decides order. Both are settings-owned facts
 * about the device, which is why they come from the device payload rather than
 * from the plan.
 */
export type SettingsUiOverviewDevice = SettingsUiDeviceListItem
  & Pick<DeviceDescriptor, 'managed' | 'priority'>;

/**
 * One Overview card's inputs.
 *
 * `undecided` is not an error state and not an empty one — it is a device PELS
 * knows about and has not yet decided anything for, which is the ordinary state
 * before the first plan exists. It carries no plan fields at all rather than
 * default ones, so nothing downstream can read a decision that was never made.
 */
export type OverviewDeviceRow =
  | { kind: 'decided'; device: SettingsUiOverviewDevice; plan: PlanDeviceSnapshot }
  | { kind: 'undecided'; device: SettingsUiOverviewDevice };

/**
 * Membership mirrors the runtime's own planned-device filter
 * (`isRuntimePlannedDevice`, `setup/appDeviceSupport.ts`): `managed !== false`,
 * NOT `managed === true`.
 *
 * The difference is load-bearing. A device the owner never explicitly toggled
 * has no `managed` flag and IS planned by the runtime, so keying on `=== true`
 * would list a strictly smaller set than PELS actually manages — the Overview
 * would silently omit devices it is controlling. `state.managedMap[id] === true`
 * has exactly that shape and is deliberately not used here.
 */
const isOverviewMember = (device: SettingsUiOverviewDevice): boolean => device.managed !== false;

const byPriority = (a: SettingsUiOverviewDevice, b: SettingsUiOverviewDevice): number => (
  (a.priority ?? 999) - (b.priority ?? 999)
);

/**
 * Joins the device list to this cycle's plan on device id.
 *
 * With NO plan, every managed device is `undecided`: the plan is a decision
 * ABOUT devices and is legitimately absent — before the first power reading,
 * after a restart — while the device list is known as soon as the app has
 * parsed its devices. Rendering nothing in that window is what made a missing
 * CONTROL artefact look like a missing device.
 *
 * With a plan, the plan also answers MEMBERSHIP for the home on screen, and a
 * device it does not name is dropped. `undecided` means PELS has not decided
 * anything YET — not "this device is not mine". The distinction is load-bearing
 * under multi-home: Main's device payload is the whole home's and includes
 * devices belonging to a meter area, while Main's plan correctly excludes them.
 * Treating those as undecided would park another home's devices on Main's
 * Overview forever, waiting for a reading that is never coming for them.
 *
 * A plan row with no matching device is dropped either way — the two payloads
 * refresh independently, and a decision about a device this scope cannot show
 * has nothing to render on.
 */
export const buildOverviewDeviceRows = (params: {
  devices: readonly SettingsUiOverviewDevice[];
  plan: PlanSnapshot | null;
}): OverviewDeviceRow[] => {
  const planById = new Map<string, PlanDeviceSnapshot>(
    (params.plan?.devices ?? []).map((device) => [device.id, device]),
  );
  const planExists = params.plan !== null;
  return params.devices
    .filter(isOverviewMember)
    .slice()
    .sort(byPriority)
    .flatMap((device): OverviewDeviceRow[] => {
      const plan = planById.get(device.id);
      if (plan) return [{ kind: 'decided', device, plan }];
      return planExists ? [] : [{ kind: 'undecided', device }];
    });
};
