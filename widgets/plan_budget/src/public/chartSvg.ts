// Low-level SVG primitives for the plan_budget chart renderer: element creation,
// node clearing, and the two path-string builders (price polyline, rounded bar).
// Split out of chart.ts purely to keep that file under the max-lines budget; pure
// DOM/string helpers with no chart-specific layout knowledge.

const SVG_NS = 'http://www.w3.org/2000/svg';

export type SvgAttributeValue = number | string | null | undefined;
export type SvgAttributes = Record<string, SvgAttributeValue>;
export type Point = { x: number; y: number };

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

export const clearNode = (node: Node): void => {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
};

export const buildPathData = (points: ReadonlyArray<Point | null>): string => {
  const commands: string[] = [];
  let pendingMove = true;

  for (const point of points) {
    if (!point) {
      pendingMove = true;
      continue;
    }

    commands.push(`${pendingMove ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
    pendingMove = false;
  }

  return commands.join(' ');
};

export const buildBarPath = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string => {
  const safeHeight = Math.max(0, height);
  const safeRadius = Math.min(radius, width / 2, safeHeight);
  const right = x + width;
  const bottom = y + safeHeight;

  if (safeRadius <= 0 || safeHeight <= 0) {
    return `M ${x} ${bottom} L ${x} ${y} L ${right} ${y} L ${right} ${bottom} Z`;
  }

  return [
    `M ${x} ${bottom}`,
    `L ${x} ${y + safeRadius}`,
    `Q ${x} ${y} ${x + safeRadius} ${y}`,
    `L ${right - safeRadius} ${y}`,
    `Q ${right} ${y} ${right} ${y + safeRadius}`,
    `L ${right} ${bottom}`,
    'Z',
  ].join(' ');
};
