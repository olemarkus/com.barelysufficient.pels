import { render } from 'preact';
import { HOME_SCOPE_BAR_LABEL } from '../../../../shared-domain/src/homeScopeCopy.ts';
import { MdFilledTonalButton, MdMenu, MdMenuItem } from './materialWebJSX.tsx';

// The shell's global home scope bar (multi-home): one 48 px row that names which
// part of the home the page is about.
//
// A Material menu button (`md-filled-tonal-button` + `md-menu`), NOT a form
// field. The bar is chrome, not something the page is asking you to fill in: the
// filled-field costume made it the brightest, largest object above the fold and
// out-ranked the tab strip beside it, and its full-width stretch both wasted
// ~140 px at 480 px and truncated a real Norwegian area name at 320 px. This is
// content-sized, so `Leilighet i underetasjen` renders in full at 320 px.
//
// A tonal BUTTON rather than an assist chip: M3's assist chip is a suggested
// action, not a picker, and — decisively — it exposes only a LEADING icon slot,
// which forced the dropdown caret into the label text as a bare `▾` glyph in the
// label's own colour and weight. The button's `trailing-icon` slot carries the
// real Material `arrow_drop_down` path, the same glyph the `md-filled-select` on
// this very screen renders, so the two pickers stop speaking two caret
// languages. The tonal variant also has a real container-colour token, so the
// control has an actual fill instead of sitting at the page background.
//
// Deliberately NOT wrapped in a `<label>`: a Material menu inside a label
// collapses immediately on open in Firefox, because the label re-dispatches the
// opening click to its control and the menu reads that as an outside click
// (regression pinned by `md-select-stays-open.spec.ts`).
//
// All data + callbacks arrive as props (views/AGENTS.md) — including whether the
// menu is open. That flag CANNOT live here as component state: Material closes
// its own menu on item activation and outside clicks without going through
// Preact, so the rendered vdom would keep `open: true` while the element sat
// closed, and the next `open` would diff to a no-op — the menu opens once and
// never again. The `homeScope` orchestrator owns the flag (and re-syncs it from
// the element's own `closed` event), the roster, the selection, and the mount's
// `hidden` flag.

const CHIP_ID = 'home-scope-chip';

export type HomeScopeOption = { homeId: string; label: string };

export type HomeScopeBarProps = {
  /** False until a meter area exists on a page whose content honours the scope. */
  visible: boolean;
  /** Main home first, then each meter area. */
  options: HomeScopeOption[];
  selectedHomeId: string;
  onSelectHome: (homeId: string) => void;
  /** Owned by the orchestrator — see the note above on why not local state. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
};

const HomeScopeBarView = (props: HomeScopeBarProps) => {
  if (!props.visible) return null;
  const selected = props.options.find((option) => option.homeId === props.selectedHomeId);
  const selectedLabel = selected?.label ?? props.options[0]?.label ?? '';

  return (
    <div class="scope-bar">
      <span class="scope-bar__label">{HOME_SCOPE_BAR_LABEL}</span>
      <span class="scope-bar__anchor">
        <MdFilledTonalButton
          id={CHIP_ID}
          class="scope-bar__chip"
          trailing-icon
          onClick={() => props.onMenuOpenChange(!props.menuOpen)}
        >
          {selectedLabel}
          <svg slot="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M7 10l5 5 5-5z" fill="currentColor" />
          </svg>
        </MdFilledTonalButton>
        {/* `open` rides as a prop, not a ref: Preact strips `ref` on function
            components, and these Material wrappers are plain functions — a ref
            here silently never lands and the menu never opens. The element is
            upgraded by the time props diff, so Preact assigns the JS property. */}
        {/* Mounted only while open. Material's menu keeps internal state tied
            to its items, and this bar re-renders on every scope change, so a
            persistent menu goes stale: it reports itself open while its surface
            stays collapsed, and the picker works exactly once. A fresh element
            per open has no history to be wrong about. */}
        {props.menuOpen && (
          <MdMenu
            class="scope-bar__menu"
            anchor={CHIP_ID}
            positioning="fixed"
            open
            /* Lowercase on purpose. Material dispatches `new Event('closed')`,
               and for a non-builtin event Preact binds the prop name verbatim
               after stripping `on` — `onClosed` listens for the case-sensitive
               type `Closed`, which never fires, so an outside-click or Escape
               dismissal left the open flag stale and the next chip tap died
               unmounting an already-closed menu. */
            /* Connected-only: a pick unmounts this menu at once, but its close
               animation keeps running on the detached element and still ends in
               a `closed` dispatch (menu.js fires it from the animation's finish
               handler). By then the user may have opened the NEXT menu, and the
               stale echo would close it mid-tap. A real dismissal always fires
               while the menu is still mounted — nothing has unmounted it yet. */
            onclosed={(event: Event) => {
              if ((event.currentTarget as Element).isConnected) props.onMenuOpenChange(false);
            }}
          >
            {props.options.map((option) => (
              <MdMenuItem
                key={option.homeId}
                id={`home-scope-option-${option.homeId}`}
                data-home-id={option.homeId}
                {...(option.homeId === props.selectedHomeId ? { selected: true } : {})}
                onClick={() => props.onSelectHome(option.homeId)}
              >
                <div slot="headline">{option.label}</div>
              </MdMenuItem>
            ))}
          </MdMenu>
        )}
      </span>
    </div>
  );
};

export const renderHomeScopeBar = (
  surface: HTMLElement,
  props: HomeScopeBarProps,
): void => {
  render(<HomeScopeBarView {...props} />, surface);
};
