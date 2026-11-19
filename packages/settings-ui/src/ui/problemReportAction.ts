/** The warning or recommendation the owner chose to ask about. */
export type ProblemReportAction = { deviceId?: string; message: string };

export const PROBLEM_REPORT_ACTION = 'pels:open-contextual-problem-report';

export const openContextualProblemReport = (action: ProblemReportAction): void => {
  document.dispatchEvent(new CustomEvent<ProblemReportAction>(PROBLEM_REPORT_ACTION, { detail: action }));
};
