import type { JSX } from 'preact';
import type { ChipTone } from './chipTone.ts';

type ChipProps = Omit<JSX.HTMLAttributes<HTMLSpanElement>, 'class' | 'className'> & {
  tone: ChipTone;
};

/** Shared display chip; callers supply resolved text and optional semantic attributes. */
export const Chip = ({ tone, ...props }: ChipProps) => (
  <span {...props} class={`plan-chip plan-chip--${tone}`} />
);
