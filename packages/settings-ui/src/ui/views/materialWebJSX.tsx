import { h } from 'preact';
import type { JSX, ComponentChildren } from 'preact';

type MdBaseProps = JSX.HTMLAttributes<HTMLElement> & { children?: ComponentChildren };

export const MdElevation = (props: MdBaseProps) => (
  h('md-elevation', props as Record<string, unknown>)
);

export const MdRipple = (props: MdBaseProps) => (
  h('md-ripple', props as Record<string, unknown>)
);
