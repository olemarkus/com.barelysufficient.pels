import { MdIconButton } from './materialWebJSX.tsx';
import { ArrowBackIcon } from './icons.tsx';

// Shared navigation app-bar row: a 48 px icon back button + page title, with an
// optional supporting lede line for copy-bearing sub-pages. One implementation
// so every Preact-rendered settings sub-page emits chrome identical to the
// static-HTML `.pels-appbar` instances in `public/index.html` — two hand-rolled
// copies drift, which is exactly what the navigation-chrome unification removed.
//
// `back` accepts either a declarative `target` (a `data-settings-target` the
// global boot.ts click-delegate routes through `showTab`) or an imperative
// `onClick` (editors like Budget-adjust whose exit runs an injected navigator
// with unsaved-draft handling). `label` is the back control's aria-label;
// `title`/`class` are optional passthroughs so an editor can reflect a confirm
// state on the same control. `lede` is the muted descriptor line beneath the
// bar — present only on copy-bearing pages (Electricity prices, Price-aware
// devices), so the lede is the shared "this page explains itself" pattern.
export type AppBarBack = {
  label: string;
  target?: string;
  onClick?: (event: Event) => void;
  title?: string;
  class?: string;
};

export type AppBarProps = {
  back: AppBarBack;
  title: string;
  lede?: string;
};

export const AppBar = ({ back, title, lede }: AppBarProps) => (
  <>
    <div class="pels-appbar">
      <MdIconButton
        type="button"
        class={`pels-appbar__back${back.class ? ` ${back.class}` : ''}`}
        aria-label={back.label}
        {...(back.title !== undefined ? { title: back.title } : {})}
        {...(back.target !== undefined ? { 'data-settings-target': back.target } : {})}
        {...(back.onClick ? { onClick: back.onClick } : {})}
      >
        <ArrowBackIcon />
      </MdIconButton>
      <h2 class="pels-appbar__title">{title}</h2>
    </div>
    {lede !== undefined && <p class="muted pels-appbar-lede">{lede}</p>}
  </>
);
