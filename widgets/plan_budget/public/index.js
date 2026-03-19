/* global URLSearchParams, console, document, window */
(function widgetBootstrap() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEWPORT = { width: 480, height: 480 };
  const PANEL = { x: 12, y: 12, width: 456, height: 416, radius: 12 };
  const PLOT = { left: 46, right: 422, top: 30, bottom: 372 };
  const LEGEND_Y = 450;
  const X_LABEL_Y = 404;
  const GRID_LINES = 4;
  const BAR_RADIUS = 3;
  const DOT_RADIUS = 4;
  const REFRESH_INTERVAL_MS = 60 * 1000;
  const WIDGET_TITLE = 'Budget and Price';
  const DEFAULT_EMPTY_SUBTITLE = 'No plan data available';
  const LOAD_ERROR_SUBTITLE = 'Unable to load widget';

  const PREVIEW_TODAY_PAYLOAD = {
    state: 'ready',
    target: 'today',
    dateKey: '2026-03-19',
    bucketLabels: Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')),
    plannedKwh: [
      0.42, 0.38, 0.36, 0.35, 0.34, 0.38, 0.45, 0.58, 0.7, 0.82, 0.9, 0.94,
      0.88, 0.8, 0.74, 0.68, 0.72, 0.85, 1.02, 1.14, 1.08, 0.88, 0.66, 0.51,
    ],
    actualKwh: [
      0.39, 0.37, 0.33, 0.35, 0.31, 0.4, 0.48, 0.61, 0.69, 0.8, 0.87, null,
      null, null, null, null, null, null, null, null, null, null, null, null,
    ],
    showActual: true,
    priceSeries: [
      92, 88, 81, 79, 84, 95, 103, 118, 126, 132, 136, 128,
      119, 111, 108, 114, 127, 144, 156, 162, 149, 131, 118, 104,
    ],
    hasPriceData: true,
    currentIndex: 10,
    showNow: true,
    labelEvery: 4,
    maxPlan: 1.14,
    priceMin: 79,
    priceMax: 162,
  };

  const PREVIEW_TOMORROW_PAYLOAD = {
    state: 'ready',
    target: 'tomorrow',
    dateKey: '2026-03-20',
    bucketLabels: Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')),
    plannedKwh: [
      0.36, 0.34, 0.33, 0.31, 0.3, 0.32, 0.4, 0.54, 0.68, 0.75, 0.78, 0.8,
      0.76, 0.73, 0.7, 0.72, 0.8, 0.92, 1.04, 1.09, 1.01, 0.83, 0.62, 0.48,
    ],
    actualKwh: Array.from({ length: 24 }, () => null),
    showActual: false,
    priceSeries: [
      86, 81, 77, 74, 72, 78, 93, 112, 126, 141, 148, 145,
      134, 122, 118, 123, 137, 151, 167, 173, 158, 136, 118, 99,
    ],
    hasPriceData: true,
    currentIndex: 0,
    showNow: false,
    labelEvery: 4,
    maxPlan: 1.09,
    priceMin: 72,
    priceMax: 173,
  };

  const chartEl = document.getElementById('chart');

  let HomeyRef = null;
  let refreshTimer = null;
  let initialRenderDone = false;
  let visibilityListenerBound = false;
  let loadSequence = 0;

  const createSvg = (tagName, attributes = {}, textContent = '') => {
    const node = document.createElementNS(SVG_NS, tagName);
    Object.entries(attributes).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      node.setAttribute(key, String(value));
    });
    if (textContent) node.textContent = textContent;
    return node;
  };

  const clearNode = (node) => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  const formatPlanTick = (value) => {
    const rounded = Math.round(value * 10) / 10;
    return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
  };

  const formatPriceTick = (value) => String(Math.round(value));

  const resolvePriceBounds = (payload) => {
    if (!payload.hasPriceData) return { min: 0, max: 1 };
    if (Math.abs(payload.priceMax - payload.priceMin) < 0.001) {
      return {
        min: payload.priceMin - 1,
        max: payload.priceMax + 1,
      };
    }
    return {
      min: payload.priceMin,
      max: payload.priceMax,
    };
  };

  const buildPathData = (points) => {
    const commands = [];
    let pendingMove = true;

    points.forEach((point) => {
      if (!point) {
        pendingMove = true;
        return;
      }

      commands.push(`${pendingMove ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`);
      pendingMove = false;
    });

    return commands.join(' ');
  };

  const buildBarPath = (x, y, width, height, radius) => {
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

  const renderEmptyState = (payload) => {
    clearNode(chartEl);
    chartEl.setAttribute('aria-label', payload.subtitle || 'Budget and price chart unavailable');

    chartEl.appendChild(createSvg('rect', {
      class: 'chart__panel',
      x: PANEL.x,
      y: PANEL.y,
      width: PANEL.width,
      height: PANEL.height,
      rx: PANEL.radius,
      ry: PANEL.radius,
    }));

    chartEl.appendChild(createSvg('text', {
      class: 'chart__empty-title',
      x: VIEWPORT.width / 2,
      y: 214,
      'text-anchor': 'middle',
    }, payload.title || WIDGET_TITLE));

    chartEl.appendChild(createSvg('text', {
      class: 'chart__empty-subtitle',
      x: VIEWPORT.width / 2,
      y: 244,
      'text-anchor': 'middle',
    }, payload.subtitle || DEFAULT_EMPTY_SUBTITLE));
  };

  const renderLegend = (group, payload) => {
    const legendItems = [
      { type: 'plan', label: 'Plan', x: 92 },
      ...(payload.showActual ? [{ type: 'actual', label: 'Actual', x: 214 }] : []),
      { type: 'price', label: 'Price', x: payload.showActual ? 346 : 274 },
    ];

    legendItems.forEach((item) => {
      if (item.type === 'plan') {
        group.appendChild(createSvg('rect', {
          class: 'chart__legend-plan',
          x: item.x,
          y: LEGEND_Y - 7,
          width: 16,
          height: 10,
          rx: 3,
          ry: 3,
        }));
      } else if (item.type === 'actual') {
        group.appendChild(createSvg('circle', {
          class: 'chart__legend-actual',
          cx: item.x + 8,
          cy: LEGEND_Y - 2,
          r: 5,
        }));
      } else {
        group.appendChild(createSvg('line', {
          class: 'chart__legend-price',
          x1: item.x,
          y1: LEGEND_Y - 2,
          x2: item.x + 16,
          y2: LEGEND_Y - 2,
        }));
      }

      group.appendChild(createSvg('text', {
        class: 'chart__legend-text',
        x: item.x + 24,
        y: LEGEND_Y - 2,
      }, item.label));
    });
  };

  const renderReadyState = (payload) => {
    clearNode(chartEl);
    chartEl.setAttribute(
      'aria-label',
      payload.target === 'tomorrow'
        ? 'Budget and price chart for tomorrow'
        : 'Budget and price chart for today',
    );

    const chartGroup = createSvg('g');
    const panelGroup = createSvg('g');
    const plotGroup = createSvg('g');
    const labelsGroup = createSvg('g');
    const legendGroup = createSvg('g');

    chartGroup.appendChild(panelGroup);
    chartGroup.appendChild(plotGroup);
    chartGroup.appendChild(labelsGroup);
    chartGroup.appendChild(legendGroup);
    chartEl.appendChild(chartGroup);

    panelGroup.appendChild(createSvg('rect', {
      class: 'chart__panel',
      x: PANEL.x,
      y: PANEL.y,
      width: PANEL.width,
      height: PANEL.height,
      rx: PANEL.radius,
      ry: PANEL.radius,
    }));

    const plotWidth = PLOT.right - PLOT.left;
    const plotHeight = PLOT.bottom - PLOT.top;
    const bucketCount = payload.plannedKwh.length;
    const maxPlan = Math.max(1, payload.maxPlan * 1.08);
    const priceBounds = resolvePriceBounds(payload);
    const priceSpan = Math.max(1, priceBounds.max - priceBounds.min);
    const stepWidth = plotWidth / Math.max(1, bucketCount);
    const barWidth = Math.max(6, stepWidth * 0.72);

    for (let index = 0; index <= GRID_LINES; index += 1) {
      const ratio = index / GRID_LINES;
      const y = PLOT.bottom - (plotHeight * ratio);
      plotGroup.appendChild(createSvg('line', {
        class: 'chart__grid',
        x1: PLOT.left,
        y1: y,
        x2: PLOT.right,
        y2: y,
      }));

      labelsGroup.appendChild(createSvg('text', {
        class: 'chart__axis-label',
        x: PLOT.left - 8,
        y: y + 4,
        'text-anchor': 'end',
      }, formatPlanTick(maxPlan * ratio)));

      if (payload.hasPriceData) {
        const priceValue = priceBounds.min + (priceSpan * ratio);
        labelsGroup.appendChild(createSvg('text', {
          class: 'chart__axis-label',
          x: PLOT.right + 8,
          y: y + 4,
          'text-anchor': 'start',
        }, formatPriceTick(priceValue)));
      }
    }

    if (payload.showNow) {
      const currentX = PLOT.left + (stepWidth * (payload.currentIndex + 0.5));
      plotGroup.appendChild(createSvg('line', {
        class: 'chart__now',
        x1: currentX,
        y1: PLOT.top,
        x2: currentX,
        y2: PLOT.bottom,
      }));
    }

    payload.plannedKwh.forEach((value, index) => {
      const x = PLOT.left + (stepWidth * index) + ((stepWidth - barWidth) / 2);
      const height = plotHeight * (value / maxPlan);
      const y = PLOT.bottom - height;
      plotGroup.appendChild(createSvg('path', {
        class: 'chart__bar',
        d: buildBarPath(x, y, barWidth, height, BAR_RADIUS),
      }));
    });

    const pricePoints = payload.priceSeries.map((value, index) => {
      if (!Number.isFinite(value)) return null;
      return {
        x: PLOT.left + (stepWidth * (index + 0.5)),
        y: PLOT.bottom - ((value - priceBounds.min) / priceSpan) * plotHeight,
      };
    });
    const pricePath = buildPathData(pricePoints);

    if (pricePath) {
      plotGroup.appendChild(createSvg('path', {
        class: 'chart__price',
        d: pricePath,
      }));
    }

    if (payload.showNow && Number.isFinite(payload.priceSeries[payload.currentIndex])) {
      const currentPriceY = PLOT.bottom - ((payload.priceSeries[payload.currentIndex] - priceBounds.min) / priceSpan) * plotHeight;
      plotGroup.appendChild(createSvg('circle', {
        class: 'chart__price-dot',
        cx: PLOT.left + (stepWidth * (payload.currentIndex + 0.5)),
        cy: currentPriceY,
        r: DOT_RADIUS + 1,
      }));
    }

    if (payload.showActual) {
      payload.actualKwh.forEach((value, index) => {
        if (!Number.isFinite(value) || index > payload.currentIndex) return;
        plotGroup.appendChild(createSvg('circle', {
          class: 'chart__actual',
          cx: PLOT.left + (stepWidth * (index + 0.5)),
          cy: PLOT.bottom - (value / maxPlan) * plotHeight,
          r: DOT_RADIUS,
        }));
      });
    }

    payload.bucketLabels.forEach((label, index) => {
      const isVisible = (index % payload.labelEvery === 0) || index === payload.bucketLabels.length - 1;
      if (!isVisible) return;
      labelsGroup.appendChild(createSvg('text', {
        class: 'chart__axis-label',
        x: PLOT.left + (stepWidth * (index + 0.5)),
        y: X_LABEL_Y,
        'text-anchor': 'middle',
      }, label));
    });

    if (!payload.hasPriceData) {
      labelsGroup.appendChild(createSvg('text', {
        class: 'chart__badge',
        x: PANEL.x + PANEL.width - 12,
        y: PANEL.y + 22,
        'text-anchor': 'end',
      }, 'Price data missing'));
    }

    renderLegend(legendGroup, payload);
  };

  const renderWidget = (payload) => {
    if (!payload || payload.state !== 'ready') {
      renderEmptyState(payload || {
        title: WIDGET_TITLE,
        subtitle: DEFAULT_EMPTY_SUBTITLE,
      });
      return;
    }
    renderReadyState(payload);
  };

  const resolvePreviewPayload = (target) => {
    if (target === 'tomorrow') return PREVIEW_TOMORROW_PAYLOAD;
    return PREVIEW_TODAY_PAYLOAD;
  };

  const resolveTarget = (settings, searchParams) => {
    const previewTarget = searchParams.get('day');
    if (previewTarget === 'tomorrow') return 'tomorrow';
    if (previewTarget === 'today') return 'today';
    return settings && settings.day === 'tomorrow' ? 'tomorrow' : 'today';
  };

  const maybeApplyPreviewTheme = (searchParams) => {
    const theme = searchParams.get('theme');
    if (theme === 'dark') {
      document.body.classList.add('homey-dark-mode');
    } else if (theme === 'light') {
      document.body.classList.remove('homey-dark-mode');
    }
  };

  const fetchPayload = async () => {
    const searchParams = new URLSearchParams(window.location.search);
    const preview = searchParams.get('preview') === '1';
    maybeApplyPreviewTheme(searchParams);

    const settings = HomeyRef?.getSettings ? HomeyRef.getSettings() : {};
    const target = resolveTarget(settings, searchParams);

    if (preview || !HomeyRef) {
      return resolvePreviewPayload(target);
    }

    return HomeyRef.api('GET', `/chart?day=${encodeURIComponent(target)}`);
  };

  const loadAndRender = async () => {
    const loadId = ++loadSequence;

    try {
      const payload = await fetchPayload();
      if (loadId !== loadSequence) return;
      renderWidget(payload);
    } catch (error) {
      if (loadId !== loadSequence) return;
      console.error('Failed to load widget chart', error);
      renderEmptyState({
        title: WIDGET_TITLE,
        subtitle: LOAD_ERROR_SUBTITLE,
      });
    } finally {
      if (loadId === loadSequence && !initialRenderDone && HomeyRef?.ready) {
        HomeyRef.ready();
        initialRenderDone = true;
      }
    }
  };

  const startRefreshLoop = () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
      void loadAndRender();
    }, REFRESH_INTERVAL_MS);
  };

  const bindVisibilityReload = () => {
    if (visibilityListenerBound) return;
    visibilityListenerBound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void loadAndRender();
      }
    });
  };

  const bootstrap = (Homey) => {
    if (Homey && Homey === HomeyRef) return;

    HomeyRef = Homey;
    void loadAndRender();
    startRefreshLoop();
    bindVisibilityReload();
  };

  window.onHomeyReady = (Homey) => {
    bootstrap(Homey);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!window.Homey) bootstrap(null);
    }, { once: true });
  } else if (!window.Homey) {
    bootstrap(null);
  }
}());
