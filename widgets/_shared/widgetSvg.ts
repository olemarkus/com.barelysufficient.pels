// SVG element creation for the widgets' hand-drawn charts (plan_budget price
// chart, create_smart_task preview, smart_tasks trajectory). Browser-safe:
// bundled into each widget's `public/index.js` IIFE.

const SVG_NS = 'http://www.w3.org/2000/svg';

type SvgAttributes = Record<string, number | string | null | undefined>;

// A null or undefined attribute is left unset; empty text adds no text node.
export const createSvg = <TagName extends keyof SVGElementTagNameMap>(
  chartDocument: Document,
  tagName: TagName,
  attributes: SvgAttributes = {},
  textContent = '',
): SVGElementTagNameMap[TagName] => {
  const node = chartDocument.createElementNS(SVG_NS, tagName);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, String(value));
  }
  if (textContent) {
    node.textContent = textContent;
  }
  return node;
};
