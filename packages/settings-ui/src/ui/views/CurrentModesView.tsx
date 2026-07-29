import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { MAIN_HOME_ID } from '../../../../contracts/src/settingsKeys.ts';
import { MdFilledSelect, MdSelectOption } from './materialWebJSX.tsx';

export type CurrentModeRow = {
  homeId: string;
  homeName: string;
  mode: string;
  modes: readonly string[];
  unavailable: boolean;
};

type MaterialSelectElement = HTMLElement & { value: string };
type MaterialOptionElement = HTMLElement & {
  displayText: string;
  typeaheadText: string;
};

const ModeOption = ({ mode }: { mode: string }) => {
  const ref = useRef<MaterialOptionElement>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.displayText = mode;
    ref.current.typeaheadText = mode;
  }, [mode]);
  return (
    <MdSelectOption ref={ref} value={mode}>
      <div slot="headline">{mode}</div>
    </MdSelectOption>
  );
};

const ModeSelect = (props: {
  row: CurrentModeRow;
  onChange: (homeId: string, mode: string) => void;
}) => {
  const { row, onChange } = props;
  const ref = useRef<MaterialSelectElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.value = row.mode;
  }, [row.mode, row.modes]);
  return (
    <div class="settings-current-mode__row">
      <span class="field__label settings-current-mode__home-name">{row.homeName}</span>
      <MdFilledSelect
        id={row.homeId === MAIN_HOME_ID ? 'active-mode-select' : undefined}
        ref={ref}
        disabled={row.unavailable}
        value={row.mode}
        onChange={(event: Event) => {
          const mode = (event.currentTarget as MaterialSelectElement).value.trim();
          if (mode) onChange(row.homeId, mode);
        }}
      >
        {row.modes.map((mode) => <ModeOption key={mode} mode={mode} />)}
      </MdFilledSelect>
      {row.unavailable && <span class="muted">Modes couldn’t be loaded.</span>}
    </div>
  );
};

const CurrentModesView = (props: {
  rows: readonly CurrentModeRow[];
  onChange: (homeId: string, mode: string) => void;
}) => {
  const plural = props.rows.length > 1;
  return (
    <section class="settings-form-card settings-current-mode">
      <h3
        class="field__label pels-text-settings-label settings-current-mode__heading"
        id="settings-active-mode-summary"
      >
        {plural ? 'Current modes' : 'Current mode'}
      </h3>
      <div class="settings-current-mode__rows">
        {props.rows.map((row) => (
          <ModeSelect key={row.homeId} row={row} onChange={props.onChange} />
        ))}
      </div>
      <p class="muted settings-current-mode__hint">
        Priorities and temperatures stay in Modes.
      </p>
    </section>
  );
};

export const renderCurrentModesView = (
  surface: HTMLElement,
  props: Parameters<typeof CurrentModesView>[0],
): void => {
  render(<CurrentModesView {...props} />, surface);
};
