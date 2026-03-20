import { installWidget, type WidgetController, type WidgetWindow } from './widgetApp';

export const widgetController: WidgetController | null = installWidget(window as WidgetWindow, document);
