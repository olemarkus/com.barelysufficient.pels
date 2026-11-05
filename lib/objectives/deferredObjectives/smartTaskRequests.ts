import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type {
  DeferredObjectivePlanPreviewCandidate, DeferredObjectivePlanPreviewEstimate, SmartTaskQuickTargetsRead,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type {
  DeferredObjectiveSettingsEntry, DeferredObjectiveSettingsKind,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import type {
  NewSmartTaskWriteResult, SmartTaskCancelResult,
} from '../../../packages/contracts/src/smartTaskEdit';
import type { StarvationRescuePlanPreview } from '../../../packages/contracts/src/starvationRescue';
import type { MeasuredPowerObservedFields } from '../../../packages/contracts/src/types';
import type {
  CreateSmartTaskCandidateDevicesRead, WidgetObjectiveWriteResult,
} from '../../../packages/contracts/src/widgetHostApi';
import { asMeteredSnapshot } from '../../ports/meteredSnapshots';
import type { ObjectiveDeviceSource } from '../types';
import { gateCandidateExtraPermissions } from './limitGrantGate';
import { hasOpenDeferredObjective, objectiveAbsenceIsTrustworthy, readDeferredObjectiveRoster } from './objectiveStore';
import {
  clearObjectiveForDevice, createObjectiveForDevice, upsertObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps, type ObjectiveWriteOutcome,
} from './objectiveWrite';
import { buildUnavailableDeferredObjectivePlanEstimate, previewDeferredObjectivePlan } from './planPreview';
import { previewSmartTaskQuickTargetsForDevice, type SmartTaskQuickTargetPreview } from './smartTaskQuickTargets';
import {
  validateSmartTaskWrite, type SmartTaskWriteDevice, type SmartTaskWriteReads,
} from './smartTaskWriteValidation';
import { buildTaskEvaluationSnapshot, type TaskEvaluationSource } from './taskEvaluationCoordinator';

/** Live owner ports for a read-only preview. Unwired services are a startup error,
 * distinct from their legitimate empty snapshots. No planner state is mutated. */
export type SmartTaskPreviewSource<Device extends SmartTaskWriteDevice> = {
  getDailyBudget(): { getSnapshot(): DailyBudgetUiPayload | null; isEnabled(): boolean } | undefined;
  getPrice(): { getPriceUnitLabel(): string } | undefined;
  getPlan(): { getPlanDevices(): ObjectiveDeviceSource[] } | undefined;
  projectDevice(device: Device & MeasuredPowerObservedFields): ObjectiveDeviceSource;
};

/** Persistence and runtime-device reads for every request lane. */
export type SmartTaskRequestSource<Device extends SmartTaskWriteDevice> = SmartTaskWriteReads<Device> & {
  getNow(): Date;
  getActivePlanRecorder(): DeferredObjectiveDeviceWriteDeps['activePlanRecorder'] | undefined;
  getPlanHistoryRecorder(): DeferredObjectiveDeviceWriteDeps['planHistoryRecorder'] | undefined;
  openWrite(nowMs: number): DeferredObjectiveDeviceWriteDeps;
  getDeviceConfiguration(): { get(deviceId: string): { name: string } | undefined };
  status: { forgetDevice(deviceId: string): void };
  hoursRemaining: { forgetDevice(deviceId: string): void };
};

type PreviewSession<Device> = {
  state: 'ready';
  device: Device | undefined;
  storedEntry: DeferredObjectiveSettingsEntry | undefined;
  preview: SmartTaskQuickTargetPreview;
} | { state: 'unavailable' };

/** Durable scope failures remain specific; unreadable ownership or settings retry. */
const mapWriteRefusal = (
  reason: Extract<ObjectiveWriteOutcome, { persisted: false }>['reason'],
): 'device_in_sub_home' | 'device_not_planned' | 'write_refused' => (
  reason === 'device_in_sub_home' || reason === 'device_not_planned' ? reason : 'write_refused'
);

/** Owns preview assembly and validated persistence for create, edit, clear and rescue.
 * Request adapters bind owners; this service decides which operation may run. */
export class SmartTaskRequests<Device extends SmartTaskWriteDevice> {
  constructor(
    private readonly source: SmartTaskRequestSource<Device>,
    private readonly previewSource: SmartTaskPreviewSource<Device>,
    private readonly evaluation: TaskEvaluationSource,
  ) {}

  public hasDeferredObjectiveForDevice(deviceId: string): boolean {
    return hasOpenDeferredObjective(this.source.store, deviceId, this.source.getNow().getTime());
  }

  private requireDailyBudget(): NonNullable<ReturnType<SmartTaskPreviewSource<Device>['getDailyBudget']>> {
    const service = this.previewSource.getDailyBudget();
    if (!service) throw new Error('DailyBudgetService must be initialized before previewing a smart task.');
    return service;
  }

  public previewStarvationRescuePlan(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
  ): StarvationRescuePlanPreview {
    return {
      estimate: this.previewDeferredObjectivePlan(deviceId, candidate),
      deadlineAtMs: candidate.deadlineAtMs,
      hasExistingObjective: false,
      dailyBudgetEnabled: this.requireDailyBudget().isEnabled(),
    };
  }

  public previewDeferredObjectivePlan(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate {
    const session = this.openPreviewSession(deviceId);
    if (session.state === 'unavailable') return buildUnavailableDeferredObjectivePlanEstimate('settings_unavailable');
    return session.preview(gateCandidateExtraPermissions(session.device, candidate, {
      entry: session.storedEntry, absenceTrustworthy: true,
    }));
  }

  public previewSmartTaskQuickTargets(
    deviceId: string, kind: DeferredObjectiveSettingsKind, candidates: CreateSmartTaskCandidateDevicesRead,
  ): SmartTaskQuickTargetsRead {
    const session = this.openPreviewSession(deviceId);
    if (session.state === 'unavailable') return { state: 'unavailable', reason: 'settings_unavailable' };
    return previewSmartTaskQuickTargetsForDevice(
      candidates, deviceId, kind, session.preview, this.source.getNow().getTime(),
    );
  }

  private openPreviewSession(deviceId: string): PreviewSession<Device> {
    const dailyBudgetSnapshot = this.requireDailyBudget().getSnapshot();
    const price = this.previewSource.getPrice();
    if (!price) throw new Error('PriceCoordinator must be initialized before previewing a smart task.');
    const plan = this.previewSource.getPlan();
    if (!plan) throw new Error('PlanService must be initialized before previewing a smart task.');
    if (!this.source.getActivePlanRecorder()) {
      throw new Error('DeferredObjectiveActivePlanRecorder must be initialized before previewing a smart task.');
    }
    const roster = readDeferredObjectiveRoster(this.source.store);
    if (roster.status === 'unavailable') return { state: 'unavailable' };
    const device = this.source.findPlanInputDevice(deviceId);
    const meteredDevice = device && asMeteredSnapshot(device);
    const candidateDevice = meteredDevice ? this.previewSource.projectDevice(meteredDevice) : undefined;
    const planDevices = plan.getPlanDevices();
    const previewDevices = candidateDevice && !planDevices.some((entry) => entry.id === candidateDevice.id)
      ? [...planDevices, candidateDevice] : planDevices;
    const priorities = this.evaluation.getPrioritiesForDevices(previewDevices.map((entry) => entry.id));
    const devices = previewDevices.map((entry) => ({ ...entry, priority: priorities.getPriority(entry.id) }));
    const snapshot = buildTaskEvaluationSnapshot(
      this.evaluation, this.source.getNow().getTime(), devices, roster.settings, dailyBudgetSnapshot,
    );
    const priceRateLabel = price.getPriceUnitLabel();
    return {
      state: 'ready', device, storedEntry: roster.settings.objectivesByDeviceId[deviceId],
      preview: (candidate) => previewDeferredObjectivePlan(
        snapshot, this.evaluation, deviceId, candidate, priceRateLabel,
      ),
    };
  }

  public createDeferredObjective(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate, rescuePolicy: 'preserve' | 'replace',
  ): WidgetObjectiveWriteResult {
    return this.writeObjective(deviceId, candidate, rescuePolicy, 'replace_existing');
  }

  public createNewDeferredObjective(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
  ): NewSmartTaskWriteResult {
    return this.writeObjective(deviceId, candidate, 'replace', 'fresh');
  }

  private writeObjective(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
    rescuePolicy: 'preserve' | 'replace', mode: 'fresh',
  ): NewSmartTaskWriteResult;
  private writeObjective(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
    rescuePolicy: 'preserve' | 'replace', mode: 'rescue' | 'replace_existing',
  ): WidgetObjectiveWriteResult;
  private writeObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    rescuePolicy: 'preserve' | 'replace',
    mode: 'fresh' | 'rescue' | 'replace_existing',
  ): NewSmartTaskWriteResult {
    if (!this.source.getPlanHistoryRecorder() || !this.source.getActivePlanRecorder()) {
      return { ok: false, reason: 'unavailable' };
    }
    const validated = validateSmartTaskWrite(this.source, deviceId, candidate);
    if (!validated.ok) return validated;
    const { device, entry } = validated;
    const write = this.source.openWrite(this.source.getNow().getTime());
    const outcome = mode === 'replace_existing'
      ? upsertObjectiveForDevice(write, deviceId, device.name ?? null, entry, rescuePolicy)
      : createObjectiveForDevice(write, deviceId, device.name ?? null, entry, rescuePolicy);
    if (outcome.persisted) return { ok: true };
    if (outcome.reason === 'open_task_exists') {
      return { ok: false, reason: mode === 'rescue' ? 'device_not_eligible' : 'task_exists' };
    }
    return { ok: false, reason: mapWriteRefusal(outcome.reason) };
  }

  public cancelDeferredObjective(deviceId: string): SmartTaskCancelResult {
    if (!this.source.getPlanHistoryRecorder() || !this.source.getActivePlanRecorder()) {
      return { ok: false, reason: 'unavailable' };
    }
    if (objectiveAbsenceIsTrustworthy(this.source.store, deviceId)) {
      return { ok: false, reason: 'task_not_found' };
    }
    clearObjectiveForDevice(this.source.openWrite(this.source.getNow().getTime()), {
      deviceId, deviceName: this.source.getDeviceConfiguration().get(deviceId)?.name ?? null,
    });
    this.source.status.forgetDevice(deviceId);
    this.source.hoursRemaining.forgetDevice(deviceId);
    return { ok: true };
  }

  public rescueDeviceWithBudgetExemption(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
  ): WidgetObjectiveWriteResult {
    if (candidate.rescue?.exemptFromBudget !== 'always') return { ok: false, reason: 'invalid_candidate' };
    // The persistence operation checks the open task on its own read. A rescue
    // cannot replace a task created since the widget listed this device.
    return this.writeObjective(deviceId, candidate, 'preserve', 'rescue');
  }
}
