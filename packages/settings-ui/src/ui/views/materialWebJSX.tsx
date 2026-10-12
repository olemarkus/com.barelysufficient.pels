import { h } from 'preact';
import type { HTMLAttributes, ComponentChildren } from 'preact';
import type { MdSwitchElement } from '../dom.ts';

type MdBaseProps = HTMLAttributes<HTMLElement> & {
  children?: ComponentChildren;
  [key: string]: unknown;
};

export const MdElevation = (props: MdBaseProps) => (
  h('md-elevation', props as Record<string, unknown>)
);

export const MdRipple = (props: MdBaseProps) => (
  h('md-ripple', props as Record<string, unknown>)
);

export const MdSwitch = (props: MdBaseProps) => (
  h('md-switch', props as Record<string, unknown>)
);


// The `md-switch`'s `selected` after its change event: Material Web exposes the
// state as a property, not an attribute.
export const readSwitchSelected = (event: Event): boolean => (
  (event.currentTarget as MdSwitchElement).selected
);

export const MdFilledTextField = (props: MdBaseProps) => (
  h('md-filled-text-field', props as Record<string, unknown>)
);

export const MdFilledSelect = (props: MdBaseProps) => (
  h('md-filled-select', props as Record<string, unknown>)
);

export const MdSelectOption = (props: MdBaseProps) => (
  h('md-select-option', props as Record<string, unknown>)
);

export const MdFilledButton = (props: MdBaseProps) => (
  h('md-filled-button', props as Record<string, unknown>)
);

export const MdOutlinedButton = (props: MdBaseProps) => (
  h('md-outlined-button', props as Record<string, unknown>)
);

export const MdTextButton = (props: MdBaseProps) => (
  h('md-text-button', props as Record<string, unknown>)
);

export const MdIconButton = (props: MdBaseProps) => (
  h('md-icon-button', props as Record<string, unknown>)
);

export const MdCircularProgress = (props: MdBaseProps) => (
  h('md-circular-progress', props as Record<string, unknown>)
);

export const MdFilledTonalButton = (props: MdBaseProps) => (
  h('md-filled-tonal-button', props as Record<string, unknown>)
);

export const MdList = (props: MdBaseProps) => (
  h('md-list', props as Record<string, unknown>)
);

export const MdListItem = (props: MdBaseProps) => (
  h('md-list-item', props as Record<string, unknown>)
);

export const MdMenu = (props: MdBaseProps) => (
  h('md-menu', props as Record<string, unknown>)
);

export const MdMenuItem = (props: MdBaseProps) => (
  h('md-menu-item', props as Record<string, unknown>)
);
