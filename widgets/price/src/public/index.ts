import { installWidget, type WidgetController } from './widgetApp';

export const widgetController: WidgetController | null = installWidget(window, document);
