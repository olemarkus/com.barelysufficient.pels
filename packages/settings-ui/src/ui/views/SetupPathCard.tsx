import { MdElevation, MdList, MdListItem } from './materialWebJSX.tsx';
import { MAIN_HOME_ID } from '../../../../contracts/src/settingsKeys.ts';
import { formatSetupProgress, type SetupPath, type SetupStep } from '../setupPathModel.ts';

// One icon per status, in the row's leading slot. The ring/check pair carries
// the state on its own; tone (accent for done and next, muted for later) only
// reinforces it, so the list still reads with the colours flattened.
const StepIcon = ({ status }: { status: SetupStep['status'] }) => (
  <svg
    slot="start"
    class="settings-nav-card__icon setup-path__icon"
    data-status={status}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    {status === 'done'
      ? (
        <path
          d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"
          fill="currentColor"
        />
      )
      : <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2" />}
  </svg>
);

const STATUS_LABEL: Record<SetupStep['status'], string> = {
  done: 'Done',
  next: 'Next step',
  later: 'Later',
};

// Rows route through the shell's `[data-settings-target]` delegate (boot.ts),
// the same mechanism as the Settings-hub rows they are styled after, so the
// view needs no navigation callback. They carry their own class rather than
// `.settings-nav-card`: that selector names a hub row, and must keep doing so. Every step configures the Main home, and
// the Power source field only exists there, so each row names that scope.
const StepRow = ({ step }: { step: SetupStep }) => (
  <MdListItem
    type="button"
    class="setup-path__step"
    data-setup-step={step.id}
    data-setup-status={step.status}
    data-settings-target={step.target.panel}
    data-settings-anchor={step.target.anchor}
    data-settings-home-scope={MAIN_HOME_ID}
  >
    <StepIcon status={step.status} />
    <span slot="headline" class="settings-nav-card__title pels-text-card-title">{step.title}</span>
    <span slot="supporting-text" class="settings-nav-card__description">
      <span class="visually-hidden">{`${STATUS_LABEL[step.status]}. `}</span>
      {step.detail}
    </span>
    <svg slot="end" class="settings-nav-card__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m8.59 16.59 4.58-4.59-4.58-4.59L10 6l6 6-6 6-1.41-1.41z" fill="currentColor" />
    </svg>
  </MdListItem>
);

/**
 * The first-run setup path as one card: what is done, what is next, and a row
 * to tap for each. Shared by the Overview (where it leads while setup is open)
 * and the Setup & recommendations page. Both mounts live in one document, so
 * each names itself and the ids stay unique.
 */
export const SetupPathCard = ({ path, surface }: { path: SetupPath; surface: 'overview' | 'setup' }) => (
  <section
    class="pels-surface-card setup-path"
    id={`${surface}-setup-path`}
    aria-labelledby={`${surface}-setup-path-title`}
  >
    <MdElevation aria-hidden="true" />
    <div class="setup-recommendation-card__header">
      <h3 class="plan-card__title" id={`${surface}-setup-path-title`}>Set up PELS</h3>
      <span class="plan-chip plan-chip--muted">{`${formatSetupProgress(path)} done`}</span>
    </div>
    <p class="pels-card-supporting">{path.lede}</p>
    <MdList class="settings-nav-list setup-path__steps">
      {path.steps.map((step) => <StepRow key={step.id} step={step} />)}
    </MdList>
    {path.simulationNote !== null && <p class="pels-card-supporting">{path.simulationNote}</p>}
  </section>
);
