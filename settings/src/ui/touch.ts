/**
 * Touch Device Support Module
 *
 * Handles touch-friendly interactions for UI elements that typically rely on hover.
 * On touch devices, converts hover effects (like tooltips) to tap-to-toggle behavior.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if the device supports touch input.
 * Uses multiple detection methods for reliability.
 */
export const isTouchDevice = (): boolean => {
  // Check for touch events
  if ('ontouchstart' in window) return true;

  // Check for touch points
  if (navigator.maxTouchPoints > 0) return true;

  // Check media query for coarse pointer (touch screens)
  if (window.matchMedia?.('(pointer: coarse)').matches) return true;

  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets up tap-to-toggle behavior for elements with data-tooltip attributes.
 * On touch devices, tapping shows/hides the tooltip instead of hover.
 */
const setupTooltipTapToggle = () => {
  let activeTooltipElement: HTMLElement | null = null;

  const showTooltip = (element: HTMLElement) => {
    // Hide any previously active tooltip
    if (activeTooltipElement && activeTooltipElement !== element) {
      activeTooltipElement.classList.remove('tooltip-active');
    }
    element.classList.add('tooltip-active');
    activeTooltipElement = element;
  };

  const hideTooltip = (element: HTMLElement) => {
    element.classList.remove('tooltip-active');
    if (activeTooltipElement === element) {
      activeTooltipElement = null;
    }
  };

  const toggleTooltip = (element: HTMLElement) => {
    if (element.classList.contains('tooltip-active')) {
      hideTooltip(element);
    } else {
      showTooltip(element);
    }
  };

  // Use event delegation for all tooltip elements
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tooltipElement = target.closest('[data-tooltip]') as HTMLElement | null;

    if (tooltipElement) {
      e.preventDefault();
      e.stopPropagation();
      toggleTooltip(tooltipElement);
    } else if (activeTooltipElement) {
      // Clicked outside - hide active tooltip
      hideTooltip(activeTooltipElement);
    }
  }, { passive: false });

  // Also handle touch events specifically for better responsiveness
  document.addEventListener('touchend', (e) => {
    const target = e.target as HTMLElement;
    const tooltipElement = target.closest('[data-tooltip]') as HTMLElement | null;

    if (tooltipElement) {
      // Prevent click event from firing after touch
      e.preventDefault();
      toggleTooltip(tooltipElement);
    }
  }, { passive: false });
};

// ─────────────────────────────────────────────────────────────────────────────
// Usage Bar Label Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets up tap-to-toggle behavior for usage bar labels.
 * On touch devices, tapping a usage bar shows/hides its label.
 */
const setupUsageBarTapToggle = () => {
  let activeUsageBar: HTMLElement | null = null;

  const showLabel = (bar: HTMLElement) => {
    if (activeUsageBar && activeUsageBar !== bar) {
      activeUsageBar.classList.remove('usage-bar--active');
    }
    bar.classList.add('usage-bar--active');
    activeUsageBar = bar;
  };

  const hideLabel = (bar: HTMLElement) => {
    bar.classList.remove('usage-bar--active');
    if (activeUsageBar === bar) {
      activeUsageBar = null;
    }
  };

  const toggleLabel = (bar: HTMLElement) => {
    if (bar.classList.contains('usage-bar--active')) {
      hideLabel(bar);
    } else {
      showLabel(bar);
    }
  };

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const usageBar = target.closest('.usage-bar') as HTMLElement | null;
    const hasLabel = usageBar?.querySelector('.usage-bar__label');

    if (usageBar && hasLabel) {
      toggleLabel(usageBar);
    } else if (activeUsageBar) {
      hideLabel(activeUsageBar);
    }
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

let initialized = false;

/**
 * Initializes touch-friendly interactions.
 * Should be called once during app boot.
 */
export const initTouchSupport = () => {
  if (initialized) return;
  initialized = true;

  // Add CSS class to body for touch-specific styling
  if (isTouchDevice()) {
    document.body.classList.add('touch-device');
    setupTooltipTapToggle();
    setupUsageBarTapToggle();
  } else {
    document.body.classList.add('pointer-device');
  }
};
