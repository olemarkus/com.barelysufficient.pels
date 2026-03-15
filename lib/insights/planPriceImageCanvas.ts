/**
 * Canvas runtime support for ECharts server-side rendering.
 *
 * Uses @napi-rs/canvas (Skia-based, statically linked, no system deps)
 * to let ECharts render directly to a PNG canvas — no SVG intermediary.
 */

/* eslint-disable functional/immutable-data, no-param-reassign -- mock DOM objects require mutation */

type CanvasModule = {
  createCanvas: (w: number, h: number) => CanvasLike & {
    getContext: (type: '2d') => CanvasRenderingContext2DLike;
  };
  GlobalFonts?: {
    registerFromPath: (path: string, family: string) => boolean;
  };
};

type CanvasLike = {
  width: number;
  height: number;
  toBuffer: (mimeType: 'image/png') => Buffer;
};

type CanvasRenderingContext2DLike = {
  fillStyle: string;
  font: string;
  fillRect: (x: number, y: number, w: number, h: number) => void;
  fillText: (text: string, x: number, y: number) => void;
};

type EchartsRuntime = {
  setPlatformAPI: (api: { createCanvas: (w: number, h: number) => unknown }) => void;
};

type MockDomElement = {
  nodeName: string;
  nodeType: number;
  style: Record<string, string>;
  childNodes: unknown[];
  children: unknown[];
  firstChild: unknown | null;
  nextSibling: unknown | null;
  clientWidth: number;
  clientHeight: number;
  appendChild: (child: unknown) => void;
  removeChild: () => void;
  insertBefore: (child: unknown) => void;
  setAttribute: () => void;
  getAttribute: () => null;
  addEventListener: () => void;
  removeEventListener: () => void;
  querySelector: () => null;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
};

let canvasModule: CanvasModule | null = null;

const getCanvasModule = (): CanvasModule => {
  if (!canvasModule) {
    // @napi-rs/canvas calls os.homedir() during load for font cache config.
    // Homey's Docker container has no HOME set, causing ENOENT.
    if (!process.env.HOME) {
      process.env.HOME = '/tmp';
    }
    canvasModule = require('@napi-rs/canvas') as CanvasModule;
  }
  return canvasModule;
};

const patchCanvasForDom = (c: Record<string, unknown>): unknown => {
  // Assign DOM-like stubs directly onto the canvas object to preserve
  // prototype methods like getContext and toBuffer.
  const noop = (): void => {};
  const noopNull = (): null => null;
  if (!c.style) c.style = {};
  if (!c.nodeName) c.nodeName = 'CANVAS';
  if (!c.nodeType) c.nodeType = 1;
  if (!c.setAttribute) c.setAttribute = noop;
  if (!c.getAttribute) c.getAttribute = noopNull;
  if (!c.addEventListener) c.addEventListener = noop;
  if (!c.removeEventListener) c.removeEventListener = noop;
  if (!c.appendChild) c.appendChild = noop;
  if (!c.removeChild) c.removeChild = noop;
  if (!c.childNodes) c.childNodes = [];
  if (!c.children) c.children = [];
  if (!c.firstChild) c.firstChild = null;
  return c;
};

export const createMockDomContainer = (
  width: number,
  height: number,
): MockDomElement => {
  const childNodes: unknown[] = [];
  return {
    nodeName: 'DIV',
    nodeType: 1,
    style: { width: `${width}px`, height: `${height}px`, cssText: '' },
    childNodes,
    children: childNodes,
    firstChild: null,
    nextSibling: null,
    clientWidth: width,
    clientHeight: height,
    appendChild(c: unknown) {
      childNodes.push(c);
      if (!this.firstChild) this.firstChild = c;
    },
    removeChild() {},
    insertBefore(c: unknown) {
      childNodes.unshift(c);
      this.firstChild = c;
    },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; },
  };
};

const registerFonts = (canvas: CanvasModule): void => {
  if (!canvas.GlobalFonts) return;
  const path = require('node:path') as typeof import('node:path');
  // Resolve from project root — works both locally and on Homey (/app/).
  const fontsDir = path.resolve(__dirname, '..', '..', 'assets', 'fonts');
  const fonts = [
    { file: 'IBMPlexSans-Regular.ttf', family: 'IBMPlexSans' },
    { file: 'IBMPlexSans-SemiBold.ttf', family: 'IBMPlexSans' },
  ];
  for (const { file, family } of fonts) {
    try {
      canvas.GlobalFonts.registerFromPath(path.join(fontsDir, file), family);
    } catch {
      // Font file may not exist in test environments
    }
  }
};

export const initCanvasRuntime = (runtime: EchartsRuntime): void => {
  const canvas = getCanvasModule();
  registerFonts(canvas);

  // ECharts canvas renderer needs a global document for createElement('canvas')
  if (typeof globalThis.document === 'undefined') {
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return patchCanvasForDom(
            canvas.createCanvas(1, 1) as unknown as Record<string, unknown>,
          );
        }
        return createMockDomContainer(0, 0);
      },
      createTextNode: () => ({ nodeName: '#text', nodeType: 3 }),
      body: { style: {} },
    };
  }

  runtime.setPlatformAPI({
    createCanvas: (w: number, h: number) => patchCanvasForDom(
      canvas.createCanvas(w || 1, h || 1) as unknown as Record<string, unknown>,
    ),
  });
};

export const renderEmptyPng = (params: {
  width: number;
  height: number;
  background: string;
  textColor: string;
  mutedColor: string;
  title: string;
  subtitle: string;
  titleSize: number;
  subtitleSize: number;
  padding: number;
}): Uint8Array => {
  const { createCanvas: create } = getCanvasModule();
  const canvas = create(params.width, params.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = params.background;
  ctx.fillRect(0, 0, params.width, params.height);
  ctx.fillStyle = params.textColor;
  ctx.font = `600 ${params.titleSize}px sans-serif`;
  ctx.fillText(params.title, params.padding, params.padding + 46);
  ctx.fillStyle = params.mutedColor;
  ctx.font = `500 ${params.subtitleSize}px sans-serif`;
  ctx.fillText(params.subtitle, params.padding, params.padding + 86);
  const buf = canvas.toBuffer('image/png');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};
