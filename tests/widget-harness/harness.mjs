// Widget harness controller. Mounts each widget into an iframe whose document
// has a fake `window.Homey` injected BEFORE the widget bundle runs, so the
// widget takes its real `homey.api(...)` data path against the mocks in
// `mockData.mjs` — interactive (click through picker → compose → preview →
// create), with data that lives outside the bundle.
//
// Injection: the widget's own index.html is fetched and rewritten — a `<base>`
// so its `./index.css`/`./index.js` resolve, the dark token set, and
// `window.Homey = {}` (truthy, so the widget waits for `onHomeyReady` instead of
// bootstrapping with no client) go in <head>; a trailing script calls
// `parent.__mount(window)` once the bundle has registered `onHomeyReady`.
import { WIDGETS, respond, settings } from './mockData.mjs';

// Dark Homey token set (mirrors tests/widget-shots/shoot.mjs). One canonical
// value per token so the widgets render as Homey resolves them at runtime.
const DARK_TOKENS = `
:root, body, .homey-dark-mode {
  --homey-background-color:#161b21; --homey-color-mono-050:#232b33; --homey-color-mono-100:#1f262d;
  --homey-color-white:#fff; --homey-color-blue:#3f9fff; --homey-color-green:#58c56a; --homey-color-red:#f0696c;
  --homey-color-danger:#f0696c; --homey-color-success:#58c56a; --homey-color-warning:#f5a623;
  --homey-text-color:#edf1f4; --homey-text-color-light:#97a2ab; --homey-text-color-danger:#f0696c;
  --homey-text-color-success:#58c56a; --homey-text-color-warning:#f5a623;
  --homey-line-color:rgba(255,255,255,.14); --homey-line-color-light:rgba(255,255,255,.09);
  --homey-color-orange:#f5a623; --homey-color-mono-000:#ffffff;
  --homey-border-radius-default:10px; --homey-border-radius-small:6px;
  --homey-font-size-default:17px; --homey-font-size-large:20px; --homey-font-size-small:14px;
  --homey-font-weight-bold:700; --homey-font-weight-medium:500; --homey-font-weight-regular:400;
  --homey-line-height-default:24px; --homey-line-height-large:28px; --homey-line-height-small:20px;
  --homey-icon-size-medium:20px; --homey-icon-size-regular:16px; --homey-icon-size-small:14px;
  --homey-su:4px; --homey-su-1:4px; --homey-su-2:8px; --homey-su-3:12px; --homey-su-4:16px;
  --homey-su-5:20px; --homey-su-6:24px; --homey-su-7:28px; --homey-su-8:32px;
}
/* An iframe's default canvas is white; give the widget document the dark Homey
   card surface so the tile reads dark (a transparent body would show white). */
html, body { background: var(--homey-color-mono-100, #161b21); margin: 0; height: 100%; }
html, body, * { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }
/* Homey's real widget-padding classes (apps.developer.homey.app → widgets →
   styling): the dashboard insets widget content by these amounts, not the
   harness. Replicate them so the margins match the real dashboard exactly. */
.homey-widget { padding: var(--homey-su-4, 16px); }
.homey-widget-small { padding: var(--homey-su-2, 8px); }
.homey-widget-full { padding: 0; }
`;

// Current scenario per widget id (defaults to each widget's first scenario).
const scenario = Object.fromEntries(WIDGETS.map((w) => [w.id, w.scenarios[0]]));
let theme = 'dark';

// Called from inside each widget's iframe (same-origin srcdoc) once its bundle
// has registered `onHomeyReady`. Builds the mock Homey for that widget and hands
// it over, so the widget bootstraps against harness data.
window.__mount = (win) => {
  const id = win.__W;
  if (theme === 'dark') win.document.body.classList.add('homey-dark-mode');
  const homey = {
    api: (method, path) => Promise.resolve().then(() => respond(id, scenario[id], method, path)),
    getSettings: () => settings(id, scenario[id]),
    ready: () => {},
  };
  if (typeof win.onHomeyReady === 'function') win.onHomeyReady(homey);
};

// Fetch + rewrite a widget's index.html into a self-mounting srcdoc string.
// `<base href>` is unreliable inside an about:srcdoc document, so rewrite the
// widget's own `./index.css` / `./index.js` refs to absolute paths instead.
const buildSrcdoc = async (id) => {
  const html = await fetch(`/widgets/${id}/public/index.html`).then((r) => r.text());
  const headInject = `<style>${DARK_TOKENS}</style>`
    + `<script>window.Homey={};window.__W=${JSON.stringify(id)};</script>`;
  const tailInject = `<script>parent.__mount(window);</script>`;
  return html
    .replace(/(href|src)="\.\//g, `$1="/widgets/${id}/public/`)
    .replace(/<head(\s[^>]*)?>/i, (m) => `${m}${headInject}`)
    .replace(/<\/body>/i, `${tailInject}</body>`);
};

const mountWidget = async (frame, id) => {
  frame.srcdoc = await buildSrcdoc(id);
};

// Build the dashboard column (one tile + iframe per widget) and the controls.
const dash = document.querySelector('[data-dash]');
const controls = document.querySelector('[data-controls]');
const frames = new Map();

for (const widget of WIDGETS) {
  // Each widget sits under its name as a section heading, the way Homey labels
  // widgets on the dashboard.
  const section = document.createElement('section');
  section.className = 'widget';
  const heading = document.createElement('h2');
  heading.className = 'widget__title';
  heading.textContent = widget.label;
  const tile = document.createElement('div');
  tile.className = 'tile';
  const frame = document.createElement('iframe');
  frame.className = 'tile__frame';
  frame.scrolling = 'no';
  frame.style.height = `${widget.height}px`;
  tile.appendChild(frame);
  section.append(heading, tile);
  dash.appendChild(section);
  frames.set(widget.id, frame);
  void mountWidget(frame, widget.id);

  if (widget.scenarios.length > 1) {
    const ctrl = document.createElement('label');
    ctrl.className = 'ctrl';
    const ctrlLabel = document.createElement('span');
    ctrlLabel.className = 'ctrl__label';
    ctrlLabel.textContent = `${widget.label} (${widget.id})`;
    ctrl.appendChild(ctrlLabel);
    const select = document.createElement('select');
    for (const name of widget.scenarios) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      scenario[widget.id] = select.value;
      void mountWidget(frames.get(widget.id), widget.id);
    });
    ctrl.appendChild(select);
    controls.appendChild(ctrl);
  }
}

document.querySelector('[data-reload-all]').addEventListener('click', () => {
  for (const widget of WIDGETS) void mountWidget(frames.get(widget.id), widget.id);
});

const themeBtn = document.querySelector('[data-theme-toggle]');
themeBtn.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  themeBtn.textContent = `Theme: ${theme}`;
  for (const widget of WIDGETS) void mountWidget(frames.get(widget.id), widget.id);
});
