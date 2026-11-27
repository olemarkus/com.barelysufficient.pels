import { Fragment } from 'preact';
import { SETUP_INTENT_LABELS, type SetupIntent } from '../setupIntent.ts';
import { AppBar } from './AppBar.tsx';
import { MdFilledTonalButton, MdOutlinedButton } from './materialWebJSX.tsx';

type SetupIntentQuestionProps = {
  options: readonly SetupIntent[];
  selected: SetupIntent | null;
  solarNote: string | null;
  busy: boolean;
  error: string | null;
  onChoose: (intent: SetupIntent) => void;
  onBack: () => void;
};

export const SetupIntentQuestion = (props: SetupIntentQuestionProps) => (
  <>
    <AppBar title="Set up PELS" back={{ label: 'Back to setup', onClick: props.onBack }} />
    <section class="pels-surface-card setup-journey">
      <h3 class="plan-card__title">What did you install PELS for?</h3>
      {props.options.map((intent) => {
        const selected = props.selected === intent;
        const Button = selected ? MdFilledTonalButton : MdOutlinedButton;
        const note = intent === 'solar' ? props.solarNote : null;
        return <Fragment key={intent}>
          <Button type="button" disabled={props.busy} aria-pressed={selected}
            aria-describedby={note ? 'setup-intent-solar-note' : undefined} onClick={() => props.onChoose(intent)}>
            {SETUP_INTENT_LABELS[intent]}
          </Button>
          {note && <p id="setup-intent-solar-note" class="pels-card-supporting">{note}</p>}
        </Fragment>;
      })}
      {props.error && <p role="alert" class="pels-notice-warning">{props.error}</p>}
    </section>
  </>
);
