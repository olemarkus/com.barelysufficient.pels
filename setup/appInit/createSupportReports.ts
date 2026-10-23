import { HomeyReportTransport, type HomeyReportRuntime } from '../../lib/diagnostics/homeyReportTransport';
import { SupportReportEvidenceSource, type SupportReportHomey } from '../../lib/diagnostics/supportReportEvidence';
import { SupportReportService } from '../../lib/diagnostics/supportReportService';

export const createSupportReports = (homey: SupportReportHomey & HomeyReportRuntime): SupportReportService => (
  new SupportReportService(new SupportReportEvidenceSource(homey), new HomeyReportTransport(homey))
);
