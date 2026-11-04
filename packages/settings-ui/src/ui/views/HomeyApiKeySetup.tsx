import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { ChargingAccessStatus } from '../../../../contracts/src/chargingControl.ts';
import { MdFilledButton, MdOutlinedButton, MdFilledTextField } from './materialWebJSX.tsx';

export const HOMEY_API_KEY_GUIDE = 'https://support.homey.app/hc/en-us/articles/8178797067292-Create-and-use-API-Keys-on-Homey-Pro';

/** What the key block says in each access state, and its how-to line, in the words of the page it sits on. */
export type HomeyApiKeyCopy = {
  states: Record<ChargingAccessStatus['state'], string>;
  hint: string;
};

export type HomeyApiKeySetupProps = {
  access: ChargingAccessStatus;
  busy: boolean;
  copy: HomeyApiKeyCopy;
  /** The save button's label: `Save key` / `Replace key`, or the page's own combined action. */
  saveLabel: string;
  /** The page holds the save back (a setup step it still needs). */
  saveBlocked: boolean;
  /** Save the entered key; `true` clears the field. */
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  /** Shown between the key field and its buttons. */
  children?: ComponentChildren;
};

/** The default save label for a page with no combined action of its own. */
export const resolveHomeyApiKeySaveLabel = (access: ChargingAccessStatus): string => (
  access.configured ? 'Replace key' : 'Save key'
);

/**
 * The owner's one Homey API key with Flow permission, as every page that needs
 * it offers it: its state, the how-to, the key field and Save, Replace or
 * Remove. Collapsed under `Manage API key` once the key is verified. It talks
 * to the shared `ui_charging_access` routes only through the page's callbacks.
 */
export function HomeyApiKeySetup(props: HomeyApiKeySetupProps) {
  const { access, busy } = props;
  const [key, setKey] = useState('');
  const KeyContainer = access.state === 'ready' ? 'details' : 'div';
  return <KeyContainer>
    {access.state === 'ready' && <summary>Manage API key</summary>}
    <p class="field__hint">{props.copy.states[access.state]}</p>
    <p class="field__hint">{props.copy.hint} <a href={HOMEY_API_KEY_GUIDE} target="_blank" rel="noopener noreferrer">Create an API key</a></p>
    <MdFilledTextField label={access.configured ? 'Replacement API key' : 'API key'} type="password"
      autocomplete="off" value={key} disabled={busy}
      onInput={(event: Event) => setKey((event.currentTarget as HTMLInputElement).value)} />
    {props.children}
    <div class="form__actions">
      <MdFilledButton disabled={busy || !key.trim() || props.saveBlocked} onClick={async () => {
        if (await props.onSave(key)) setKey('');
      }}>{props.saveLabel}</MdFilledButton>
      {access.configured && <MdOutlinedButton disabled={busy} onClick={props.onRemove}>Remove key</MdOutlinedButton>}
    </div>
  </KeyContainer>;
}
