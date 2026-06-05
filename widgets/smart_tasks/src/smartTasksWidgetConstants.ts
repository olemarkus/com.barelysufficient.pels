// Browser-safe constants shared between the node payload builder
// (smartTasksWidgetPayload.ts, allowed to bridge to lib) and the public/**
// WebView bundle. Keeping these here — rather than on the payload builder —
// means public/** never imports the node builder, so the builder can safely
// reach into lib without that runtime code becoming reachable from the
// browser bundle. Enforced by the no-public-to-node-entry dep-cruiser rule.
import { SMART_TASK_WIDGET_EMPTY_SUBTITLE } from '../../../packages/shared-domain/src/deadlineLabels';

// Re-export under the widget-local name so existing consumers/tests keep a
// stable import surface; the string itself is sourced from shared-domain so
// runtime logging and the widget render identical copy.
export const EMPTY_SUBTITLE_DEFAULT = SMART_TASK_WIDGET_EMPTY_SUBTITLE;
