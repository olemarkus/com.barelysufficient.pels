const getHomeyClient = vi.fn();

vi.mock('../src/ui/homey.ts', () => ({
  getHomeyClient: () => getHomeyClient(),
}));

const { initExternalLinks } = await import('../src/ui/externalLinks.ts');

initExternalLinks();

// Whether PELS took the click over from the browser. Read after the document
// listener has run, then cancelled so jsdom does not try to follow the link.
const click = (element: Element, init: MouseEventInit = {}): { defaultPrevented: boolean } => {
  let defaultPrevented = false;
  const settle = (event: Event) => {
    defaultPrevented = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener('click', settle, { once: true });
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...init }));
  return { defaultPrevented };
};

describe('links that open a new tab', () => {
  beforeEach(() => {
    document.body.innerHTML = [
      '<p><a id="guide" href="https://support.homey.app/guide" target="_blank" rel="noopener noreferrer"><span id="guide-text">Guide</span></a></p>',
      '<md-filled-button id="web-app" href="https://pels.barelysufficient.org/app/?open=abc" target="_blank">Open</md-filled-button>',
      '<a id="local" href="?page=budget">Budget</a>',
    ].join('');
    getHomeyClient.mockReset();
  });

  // my.homey.app sandboxes the settings page without `allow-popups`, so only
  // Homey itself can open them.
  it('opens them through Homey when Homey hosts the page', () => {
    const client = { openURL: vi.fn(function openURL(this: unknown) { return this; }) };
    getHomeyClient.mockReturnValue(client);

    const linkClick = click(document.getElementById('guide-text')!);
    const buttonClick = click(document.getElementById('web-app')!);

    expect(linkClick.defaultPrevented).toBe(true);
    expect(buttonClick.defaultPrevented).toBe(true);
    expect(client.openURL.mock.calls).toEqual([
      ['https://support.homey.app/guide'],
      ['https://pels.barelysufficient.org/app/?open=abc'],
    ]);
    // Homey's `openURL` reads its own `this`.
    expect(client.openURL.mock.results.every((result) => result.value === client)).toBe(true);
  });

  // Preact sets `target` on a Material button as a property, so only the
  // button's own shadow `<a>` names it.
  it('opens a Material link button whose target is only a property', () => {
    const client = { openURL: vi.fn() };
    getHomeyClient.mockReturnValue(client);
    const button = document.createElement('md-text-button');
    button.setAttribute('href', 'https://pels.barelysufficient.org/smart-tasks#relay');
    const inner = document.createElement('a');
    inner.setAttribute('href', 'https://pels.barelysufficient.org/smart-tasks#relay');
    inner.setAttribute('target', '_blank');
    button.attachShadow({ mode: 'open' }).append(inner);
    document.body.append(button);

    expect(click(inner).defaultPrevented).toBe(true);
    expect(client.openURL.mock.calls).toEqual([['https://pels.barelysufficient.org/smart-tasks#relay']]);
  });

  it('leaves them to the browser in the web app, which has no openURL', () => {
    getHomeyClient.mockReturnValue({});

    expect(click(document.getElementById('guide')!).defaultPrevented).toBe(false);
  });

  it('leaves in-page links and other mouse buttons alone', () => {
    const client = { openURL: vi.fn() };
    getHomeyClient.mockReturnValue(client);

    expect(click(document.getElementById('local')!).defaultPrevented).toBe(false);
    expect(click(document.getElementById('guide')!, { button: 1 }).defaultPrevented).toBe(false);
    expect(client.openURL).not.toHaveBeenCalled();
  });
});
