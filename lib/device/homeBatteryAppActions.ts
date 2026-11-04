/**
 * The common host of every home battery whose integration drives it through
 * its app's own Flow action cards (`HomeBatteryActionBinding`,
 * `notes/battery-vendor-bindings.md`). The integration states which cards
 * carry out each command and each hand-back; this host owns all of the I/O:
 * the installed card inventory, the device reads an integration resolves
 * against, and the runs, through the one owner of the owner's Homey API key
 * (`HomeyActionAccess`, shared with charger current). It names no app.
 *
 * - **Fail closed.** A battery is drivable only while every card any of its
 *   commands or its hand-back would run is in the last inventory read, and
 *   its integration resolved its actions from the device reads. A card that
 *   is missing or renamed, or actions the integration cannot resolve, leave
 *   the battery one PELS can only observe, logged once per reason. Before the
 *   first inventory read the battery reads as not observed yet. Nothing is
 *   guessed and nothing crashes.
 * - **The key.** The actions need the owner's Homey API key with Flow
 *   permission. With none saved, or one Homey refused Flow permission, the
 *   battery reads `homey_api_key_missing`: PELS only watches it. A saved key
 *   not checked yet, or one whose last check could not reach Homey, is not a
 *   missing key: the runner checks it again before its next action.
 * - **The inventory** is read when a full device read shows a battery bound to
 *   app actions, and again `CARD_INVENTORY_MAX_AGE_MS` later, or
 *   `CARD_INVENTORY_RETRY_MS` after a read or a run failed. A command runs
 *   against the inventory last read, never a fresh read per command: a battery
 *   setpoint can change every few seconds.
 *
 * Commands are sequences: the steps run one at a time in order, and a step
 * that fails stops the sequence and throws, as any refused write does.
 */
import type { HomeBatterySetpointRange } from '../../packages/contracts/src/types';
import type { BatteryCommandKeepAlive, BatteryControlRead } from '../ports/batteryControlOwner';
import { normalizeError } from '../utils/errorUtils';
import type { HomeyDeviceLike, Logger } from '../utils/types';
import { toTargetPowerCapabilityValue } from '../utils/storageSetpoint';
import type { HomeBatteryActionBinding, HomeBatteryActions, HomeBatteryCommandLifetime } from './deviceAdapter';
import { getDeviceAdapter } from './deviceAdapterRegistry';
import {
  FLOW_ACTION_CARDS_API_PATH,
  readFlowActionCardIds,
  resolveDeviceActionCard,
  type DeviceActionStep,
  type FlowActionCardIds,
} from './flowActionCards';
import type { HomeyActionAccess, HomeyFlowAction } from './transport/homeyActionAccess';
import { getRawFromHomeyApi } from './transport/managerHomeyApi';

/** How long an inventory read stands before the next full device read reads it again. */
export const CARD_INVENTORY_MAX_AGE_MS = 60 * 60_000;
/** How soon after a failed inventory read, or a failed run, the inventory is read again. */
export const CARD_INVENTORY_RETRY_MS = 60_000;

/**
 * The battery as the owner reads it when its binding is app actions:
 * `unobserved` until the card inventory has been read (nothing is known about
 * its actions yet, so a hand-back owed waits rather than failing), then
 * `observe_only`, `homey_api_key_missing` or `app_actions`.
 */
export type AppActionBatteryControl = Extract<BatteryControlRead,
  { kind: 'unobserved' } | { kind: 'observe_only' } | { kind: 'homey_api_key_missing' } | { kind: 'app_actions' }
>;

type CardInventory =
  | { kind: 'unread'; retryAtMs: number }
  | { kind: 'read'; cards: FlowActionCardIds; refreshAtMs: number };

/** A battery's actions, each step bound to an installed card. */
type ResolvedActions = {
  binding: HomeBatteryActionBinding;
  actions: HomeBatteryActions;
  cards: FlowActionCardIds;
};

type Resolution =
  | { kind: 'resolved'; resolved: ResolvedActions }
  | { kind: 'cards_unread' }
  | { kind: 'unavailable'; reasonCode: string };

/**
 * How a command is kept in force: an expiring one is sent again at half its
 * lifetime, so one late plan rebuild or one failed send still lands before
 * the app's countdown runs out.
 */
const toKeepAlive = (lifetime: HomeBatteryCommandLifetime): BatteryCommandKeepAlive => (
  lifetime.kind === 'persistent' ? { kind: 'none' } : { kind: 'resend', everyMs: Math.floor(lifetime.lifetimeMs / 2) }
);

/** Every step a battery's actions could run: a full charge, a full discharge, a 0 W hold, and the hand-back. */
const everyStep = (actions: HomeBatteryActions): readonly DeviceActionStep[] => [
  ...actions.command(actions.range.maxW),
  ...actions.command(actions.range.minW),
  ...actions.command(0),
  ...actions.handBack,
];

export class HomeBatteryAppActions {
  private inventory: CardInventory = { kind: 'unread', retryAtMs: 0 };
  private inventoryRead: Promise<void> | undefined;
  /** The reason each battery was last logged unavailable, so each change is logged once. */
  private readonly unavailable = new Map<string, string>();

  /**
   * @param access The owner's Homey API key and the one action runner.
   * @param getBattery The battery's last accepted raw read (a home battery is always tracked).
   * @param getDevices Every device of the last full read, managed or not: what
   *   an integration may resolve a sibling device from.
   */
  constructor(
    private readonly access: HomeyActionAccess,
    private readonly getBattery: (deviceId: string) => HomeyDeviceLike | undefined,
    private readonly getDevices: () => readonly HomeyDeviceLike[],
    private readonly logger: Pick<Logger, 'structuredLog'>,
  ) {}

  /** A full device read: read the card inventory when a battery there needs it and it is due. */
  observeDevices(devices: readonly HomeyDeviceLike[], nowMs: number): void {
    if (!devices.some((device) => this.bindingOf(device) !== undefined)) return;
    if (this.isInventoryDue(nowMs)) void this.refreshCards();
  }

  /** Read the card inventory now, joining a read already running. Never rejects. */
  refreshCards(): Promise<void> {
    this.inventoryRead ??= getRawFromHomeyApi(FLOW_ACTION_CARDS_API_PATH).then(
      (raw) => {
        this.inventory = {
          kind: 'read', cards: readFlowActionCardIds(raw), refreshAtMs: Date.now() + CARD_INVENTORY_MAX_AGE_MS,
        };
      },
      (error: unknown) => {
        // A failed read keeps the cards last read: they were installed then.
        if (this.inventory.kind === 'read') this.inventory = { ...this.inventory, refreshAtMs: this.retryAt() };
        else this.inventory = { kind: 'unread', retryAtMs: this.retryAt() };
        this.logger.structuredLog.warn({ event: 'home_battery_action_cards_read_failed', err: normalizeError(error) });
      },
    ).finally(() => { this.inventoryRead = undefined; });
    return this.inventoryRead;
  }

  /** The battery as the owner reads it (`BatteryControlRead`). */
  readControl(deviceId: string): AppActionBatteryControl {
    const resolution = this.resolve(deviceId);
    if (resolution.kind === 'cards_unread') return { kind: 'unobserved' };
    if (resolution.kind === 'unavailable') {
      this.noteUnavailable(deviceId, resolution.reasonCode);
      return { kind: 'observe_only' };
    }
    this.unavailable.delete(deviceId);
    const { state } = this.access.status();
    if (state === 'not_configured' || state === 'permission_denied') return { kind: 'homey_api_key_missing' };
    const { binding, actions } = resolution.resolved;
    return { kind: 'app_actions', range: actions.range, keepAlive: toKeepAlive(binding.commandLifetime) };
  }

  /**
   * Command `setpointW` (PELS's sign), mapped onto the battery's range. Returns
   * the watts commanded. Throws when the battery's actions cannot run, or a
   * step failed.
   */
  async command(deviceId: string, setpointW: number): Promise<number> {
    const resolved = this.requireResolved(deviceId);
    const commandedW = toTargetPowerCapabilityValue(setpointW, resolved.actions.range);
    await this.runSteps(deviceId, resolved, resolved.actions.command(commandedW));
    return commandedW;
  }

  /** Hand the battery back to its own mode. Throws when its actions cannot run, or a step failed. */
  async handBack(deviceId: string): Promise<void> {
    const resolved = this.requireResolved(deviceId);
    await this.runSteps(deviceId, resolved, resolved.actions.handBack);
  }

  private async runSteps(
    deviceId: string,
    resolved: ResolvedActions,
    steps: readonly DeviceActionStep[],
  ): Promise<void> {
    // Refused before any step without the key, rather than by the first run.
    this.assertRunnable(deviceId);
    for (const step of steps) {
      const action = this.bindStep(resolved, step);
      try {
        // The battery may have lost its actions or its key while an earlier
        // step ran; the runner checks this again just before its POST.
        await this.access.runAction(deviceId, action, 'home_battery', () => this.assertRunnable(deviceId));
      } catch (error) {
        // A card that went missing after the inventory was read fails its run:
        // read the inventory again soon rather than wait out its age.
        this.markInventoryStale();
        throw error;
      }
    }
  }

  private bindStep(resolved: ResolvedActions, step: DeviceActionStep): HomeyFlowAction {
    const action = resolveDeviceActionCard(resolved.cards, resolved.binding.appUri, step);
    if (action === undefined) throw new Error(`The battery app's action ${step.actionId} is unavailable in Homey.`);
    return action;
  }

  private assertRunnable(deviceId: string): void {
    const control = this.readControl(deviceId);
    if (control.kind !== 'app_actions') throw new Error(`Home battery ${deviceId} app actions are unavailable.`);
  }

  private requireResolved(deviceId: string): ResolvedActions {
    const resolution = this.resolve(deviceId);
    if (resolution.kind !== 'resolved') {
      const reasonCode = resolution.kind === 'unavailable' ? resolution.reasonCode : 'action_cards_unread';
      throw new Error(`Home battery ${deviceId} app actions are unavailable (${reasonCode}).`);
    }
    return resolution.resolved;
  }

  private bindingOf(device: HomeyDeviceLike): HomeBatteryActionBinding | undefined {
    const binding = getDeviceAdapter(device).homeBatteryBinding(device);
    return binding.kind === 'app_actions' ? binding : undefined;
  }

  private resolve(deviceId: string): Resolution {
    const device = this.getBattery(deviceId);
    if (device === undefined) return { kind: 'unavailable', reasonCode: 'battery_unread' };
    const binding = this.bindingOf(device);
    if (binding === undefined) return { kind: 'unavailable', reasonCode: 'not_app_actions' };
    const resolution = binding.resolve(device, this.getDevices());
    if (resolution.kind === 'unavailable') return resolution;
    if (this.inventory.kind !== 'read') return { kind: 'cards_unread' };
    const { cards } = this.inventory;
    const resolved = { binding, actions: resolution.actions, cards };
    const missing = everyStep(resolution.actions)
      .find((step) => resolveDeviceActionCard(cards, binding.appUri, step) === undefined);
    if (missing !== undefined) return { kind: 'unavailable', reasonCode: `action_card_missing:${missing.actionId}` };
    if (!isUsableRange(resolution.actions.range)) return { kind: 'unavailable', reasonCode: 'not_signed_range' };
    return { kind: 'resolved', resolved };
  }

  private noteUnavailable(deviceId: string, reasonCode: string): void {
    if (this.unavailable.get(deviceId) === reasonCode) return;
    this.unavailable.set(deviceId, reasonCode);
    this.logger.structuredLog.warn({ event: 'home_battery_actions_unavailable', deviceId, reasonCode });
  }

  private isInventoryDue(nowMs: number): boolean {
    return this.inventory.kind === 'read' ? nowMs >= this.inventory.refreshAtMs : nowMs >= this.inventory.retryAtMs;
  }

  private markInventoryStale(): void {
    if (this.inventory.kind === 'read') this.inventory = { ...this.inventory, refreshAtMs: this.retryAt() };
  }

  private retryAt(): number {
    return Date.now() + CARD_INVENTORY_RETRY_MS;
  }
}

/** A range PELS can command both ways: `minW < 0 < maxW`, a positive step, an exclude band around 0. */
const isUsableRange = (range: HomeBatterySetpointRange): boolean => (
  Number.isFinite(range.minW) && Number.isFinite(range.maxW) && Number.isFinite(range.stepW)
  && range.minW < 0 && range.maxW > 0 && range.stepW > 0
  && range.excludeMinW <= 0 && range.excludeMaxW >= 0
);
