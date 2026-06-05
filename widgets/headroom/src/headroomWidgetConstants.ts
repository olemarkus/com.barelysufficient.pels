// Browser-safe constants shared between the node payload builder
// (headroomWidgetPayload.ts, allowed to bridge to lib) and the public/**
// WebView bundle. Keeping these here — rather than on the payload builder —
// means public/** never imports the node builder, so the builder can safely
// reach into lib without that runtime code becoming reachable from the
// browser bundle. Enforced by the no-public-to-node-entry dep-cruiser rule.
import { HEADROOM_WIDGET_COPY } from '../../../packages/shared-domain/src/headroomWidgetCopy';

export const EMPTY_SUBTITLE_DEFAULT = HEADROOM_WIDGET_COPY.noDataSubtitle;
