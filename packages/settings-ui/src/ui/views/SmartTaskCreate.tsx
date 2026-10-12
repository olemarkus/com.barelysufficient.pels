import { render } from 'preact';
import {
  CREATE_SMART_TASK_WIDGET_COPY,
  deadlineLabels,
  formatSmartTaskGoalRangeHint,
  SMART_TASK_AFTER_TASK_COPY,
  SMART_TASK_CREATE_PAGE_COPY,
  SMART_TASK_EXTRA_PERMISSION_HINTS,
  SMART_TASK_EXTRA_PERMISSION_LABELS,
  SMART_TASK_EXTRA_PERMISSIONS_TITLE,
} from '../../../../shared-domain/src/deadlineLabels.ts';
import {
  resolveSmartTaskCreateBack,
  type SmartTaskCreateSnapshot,
  type SmartTaskCreateStep,
} from '../smartTaskCreate.ts';
import type { SmartTaskEditPermissionKey } from '../smartTaskEdit.ts';
import { SmartTaskPermissionRow } from './DeadlinePlan.tsx';
import { ExpandMoreIcon } from './icons.tsx';
import { MdFilledButton, MdFilledTextField, MdTextButton } from './materialWebJSX.tsx';

/** What the New smart task flow can ask its controller to do. */
export type SmartTaskCreateActions = {
  onBack: () => void;
  onRetry: () => void;
  onSelectDevice: (deviceId: string) => void;
  onGoalInput: (goal: string) => void;
  onReadyByInput: (readyBy: string) => void;
  onPermissionToggle: (key: SmartTaskEditPermissionKey, value: boolean) => void;
  onPreview: () => void;
  onCreate: () => void;
  onChangeDeviceSettings: () => void;
};

export type SmartTaskCreateViewProps = {
  snapshot: SmartTaskCreateSnapshot;
  // Who starts the device once the task is done (`deviceStartRule.ts`), shown
  // on the preview; null when there is nothing to state.
  afterTaskLine: string | null;
  actions: SmartTaskCreateActions;
};

const BACK_LABELS = {
  edit_goal: SMART_TASK_CREATE_PAGE_COPY.editGoal,
  choose_device: SMART_TASK_CREATE_PAGE_COPY.chooseAnotherDevice,
  leave: CREATE_SMART_TASK_WIDGET_COPY.backButton,
} as const;

const PERMISSION_KEYS = ['exemptFromBudget', 'limitLowerPriorityDevices', 'pauseLowerPriorityDevices'] as const;

const DevicePicker = ({ step, view }: {
  step: Extract<SmartTaskCreateStep, { kind: 'pick' }>;
  view: SmartTaskCreateViewProps;
}) => (
  <div class="smart-task-create__picker">
    <p class="pels-card-supporting">
      {step.devices.length === 0 ? SMART_TASK_CREATE_PAGE_COPY.noDevices : SMART_TASK_CREATE_PAGE_COPY.pickPrompt}
    </p>
    {step.devices.map((device) => (
      <button
        type="button"
        class="hy-nostyle pels-surface-card smart-task-create__device"
        key={device.deviceId}
        onClick={() => view.actions.onSelectDevice(device.deviceId)}
      >
        <strong>{device.deviceName}</strong>
        <span>
          {step.openTaskDeviceIds.has(device.deviceId)
            ? SMART_TASK_CREATE_PAGE_COPY.openTask
            : deadlineLabels(device.kind).kindChipLabel}
        </span>
      </button>
    ))}
  </div>
);

const ComposeFields = ({ step, view }: {
  step: Extract<SmartTaskCreateStep, { kind: 'compose' }>;
  view: SmartTaskCreateViewProps;
}) => {
  const { device, draft } = step;
  const { actions } = view;
  const disabled = view.snapshot.busy !== 'idle';
  return (
    <>
      <label class="field">
        <span class="field__label pels-text-settings-label">
          {CREATE_SMART_TASK_WIDGET_COPY.goalLabel} ({device.unitSymbol})
        </span>
        <MdFilledTextField
          type="number"
          inputMode="decimal"
          min={String(device.goalMin)}
          max={String(device.goalMax)}
          step={String(device.goalStep)}
          value={draft.goal}
          disabled={disabled}
          onInput={(event: Event) => actions.onGoalInput((event.target as HTMLInputElement).value)}
        />
        <small class="field__hint">
          {formatSmartTaskGoalRangeHint(device.goalMin, device.goalMax, device.unitSymbol)}
        </small>
      </label>
      <label class="field">
        <span class="field__label pels-text-settings-label">{CREATE_SMART_TASK_WIDGET_COPY.readyByLabel}</span>
        <input
          class="smart-task-edit__time-input"
          type="time"
          value={draft.readyBy}
          disabled={disabled}
          onInput={(event: Event) => actions.onReadyByInput((event.target as HTMLInputElement).value)}
        />
      </label>
      <details class="smart-task-edit__permissions">
        <summary class="smart-task-edit__permissions-summary">
          <span class="plan-card__title">{SMART_TASK_EXTRA_PERMISSIONS_TITLE}</span>
          <ExpandMoreIcon class="disclosure-chevron" />
        </summary>
        <small class="section-hint">{CREATE_SMART_TASK_WIDGET_COPY.extraPermissionsHint}</small>
        {PERMISSION_KEYS
          .filter((key) => key !== 'limitLowerPriorityDevices' || device.supportsLimitLowerPriority)
          .map((key) => (
            <SmartTaskPermissionRow
              key={key}
              label={SMART_TASK_EXTRA_PERMISSION_LABELS[key]}
              hint={SMART_TASK_EXTRA_PERMISSION_HINTS[key]}
              selected={draft.permissions[key]}
              disabled={disabled}
              onToggle={(value) => actions.onPermissionToggle(key, value)}
            />
          ))}
      </details>
    </>
  );
};

const AfterTaskNote = ({ line, onChange }: { line: string; onChange: () => void }) => (
  <div class="smart-task-create__after-task">
    <p class="plan-card__title">{SMART_TASK_AFTER_TASK_COPY.title}</p>
    <p class="pels-card-supporting">{line}</p>
    <MdTextButton onClick={onChange}>{SMART_TASK_AFTER_TASK_COPY.changeAction}</MdTextButton>
  </div>
);

const PreviewBody = ({ step, view }: {
  step: Extract<SmartTaskCreateStep, { kind: 'preview' }>;
  view: SmartTaskCreateViewProps;
}) => {
  const { preview } = step;
  const { afterTaskLine, actions } = view;
  const { busy } = view.snapshot;
  const createLabel = preview.cannotFinish
    ? CREATE_SMART_TASK_WIDGET_COPY.createAnywayButton
    : CREATE_SMART_TASK_WIDGET_COPY.createButton;
  return (
    <div class="smart-task-create__preview">
      <p class="plan-card__title">{CREATE_SMART_TASK_WIDGET_COPY.previewTitle}</p>
      <p class="pels-text-status-line">{preview.whenLine}</p>
      {preview.verdictLine !== null && (
        <p class="pels-text-status-line" data-tone={preview.verdictTone}>{preview.verdictLine}</p>
      )}
      {preview.costLine !== null && <p class="pels-card-supporting">{preview.costLine}</p>}
      <p class="pels-card-supporting">{preview.caveat}</p>
      {afterTaskLine !== null && <AfterTaskNote line={afterTaskLine} onChange={actions.onChangeDeviceSettings} />}
      <div class="smart-task-create__actions">
        <MdFilledButton disabled={busy !== 'idle'} onClick={actions.onCreate}>
          {busy === 'create' ? CREATE_SMART_TASK_WIDGET_COPY.creating : createLabel}
        </MdFilledButton>
      </div>
    </div>
  );
};

const SmartTaskCreate = (view: SmartTaskCreateViewProps) => {
  const { snapshot, actions } = view;
  const { step, busy, errorLine } = snapshot;
  return (
    <section class="smart-task-create" aria-labelledby="smart-task-create-title">
      <div class="smart-task-create__bar">
        <MdTextButton disabled={busy !== 'idle'} onClick={actions.onBack}>
          {BACK_LABELS[resolveSmartTaskCreateBack(snapshot)]}
        </MdTextButton>
        <h2 class="pels-text-card-title" id="smart-task-create-title">{SMART_TASK_CREATE_PAGE_COPY.newTaskAction}</h2>
      </div>
      {(step.kind === 'loading' || step.kind === 'load_error') && (
        <div class="pels-surface-card">
          <p class="pels-card-supporting">
            {step.kind === 'load_error' ? CREATE_SMART_TASK_WIDGET_COPY.loadError : CREATE_SMART_TASK_WIDGET_COPY.notReady}
          </p>
          {step.kind === 'load_error' && (
            <MdTextButton onClick={actions.onRetry}>{CREATE_SMART_TASK_WIDGET_COPY.loadErrorRetry}</MdTextButton>
          )}
        </div>
      )}
      {step.kind === 'pick' && <DevicePicker step={step} view={view} />}
      {(step.kind === 'compose' || step.kind === 'preview') && (
        <section class="pels-surface-card smart-task-create__form">
          <h3 class="pels-text-card-title">{step.device.deviceName}</h3>
          {step.kind === 'compose' && (
            <>
              <ComposeFields step={step} view={view} />
              <MdFilledButton disabled={busy !== 'idle'} onClick={actions.onPreview}>
                {busy === 'preview' ? CREATE_SMART_TASK_WIDGET_COPY.previewing : SMART_TASK_CREATE_PAGE_COPY.previewTask}
              </MdFilledButton>
            </>
          )}
          {step.kind === 'preview' && <PreviewBody step={step} view={view} />}
          {errorLine !== null && <p class="smart-task-edit__error" role="alert">{errorLine}</p>}
        </section>
      )}
    </section>
  );
};

/** Paint the flow into its surface, or clear it when the flow has closed. */
export const renderSmartTaskCreate = (
  root: HTMLElement,
  props: SmartTaskCreateViewProps | null,
): void => {
  render(props === null ? null : <SmartTaskCreate {...props} />, root);
};
