// Homey settings runs inside a WebView where some users have reported the
// browser's default anchor navigation not firing for tapped cards. Drive
// navigation from a JS click handler so taps always open the target page,
// while keeping the `href` attribute for right-click and accessibility.
//
// Only redirect plain primary clicks; middle-click, right-click, and
// modifier-clicks fall through to the anchor so users can still open the
// target in a new tab where the host environment supports it.
export const cardLinkClickHandler = (href: string) => (event: MouseEvent): void => {
  if (event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  window.location.assign(href);
};
