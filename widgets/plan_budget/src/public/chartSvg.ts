// The two path-string builders of the plan_budget chart renderer (price
// polyline, rounded bar). Split out of chart.ts purely to keep that file under
// the max-lines budget; pure string helpers with no chart-specific layout
// knowledge. Element creation and clearing are the widgets' shared
// `createSvg` (`_shared/widgetSvg.ts`) and `clearChildren` (`_shared/widgetDom.ts`).

export type Point = { x: number; y: number };

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
