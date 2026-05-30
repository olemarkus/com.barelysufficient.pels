import { h } from 'preact';
import type { JSX, ComponentChildren } from 'preact';

type MdBaseProps = JSX.HTMLAttributes<HTMLElement> & {
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
