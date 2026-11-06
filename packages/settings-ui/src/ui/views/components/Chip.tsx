import type { HTMLAttributes } from 'preact';
import type { ChipTone } from './chipTone.ts';

type ChipProps = Omit<HTMLAttributes<HTMLSpanElement>, 'className'> & {
  tone: ChipTone;
};

/** Shared display chip; callers supply resolved text and optional semantic attributes. */
export const Chip = ({ tone, class: className, ...props }: ChipProps) => (
  <span {...props} class={`plan-chip plan-chip--${tone}${className ? ` ${className}` : ''}`} />
);
