const canvasContextStubMarker = Symbol.for('pels.test.canvasContextStub');

export const installCanvasContextStub = (): void => {
  if (typeof HTMLCanvasElement === 'undefined') return;
  const current = HTMLCanvasElement.prototype.getContext as typeof HTMLCanvasElement.prototype.getContext & {
    [canvasContextStubMarker]?: boolean;
  };
  if (current[canvasContextStubMarker]) return;
  const getContext = Object.assign(
    () => ({
      measureText: (text: string) => ({ width: text.length * 8 }),
    }),
    { [canvasContextStubMarker]: true },
  );
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: getContext,
  });
};
