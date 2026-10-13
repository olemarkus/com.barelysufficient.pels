import fs from 'node:fs';
import path from 'node:path';

export const STYLE_CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations for an exact selector, including selectors in grouped rules. */
export const styleRule = (selector: string): string => Array.from(
  STYLE_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g),
).filter((match) => (match[1] ?? '').split(',').some((value) => value.trim() === selector))
  .map((match) => match[2] ?? '').join('\n');
