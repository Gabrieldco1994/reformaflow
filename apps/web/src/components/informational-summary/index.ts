/**
 * Generic informational-summary components for analytic/complex screens.
 *
 * This folder contains reusable components and utilities for rendering
 * informational summary pages across dashboards, Cockpit, Conta, DRE, Neutros,
 * cash flow, recurrences/planning/planner/budget/pending, floor-plan canvas, Gantt,
 * simulation comparison, price history, and list summaries.
 *
 * Exported:
 * - `SummaryPageHeader`: Display page title, icon, description.
 * - `SummaryCTASection`: Display call-to-action buttons/links.
 * - `useSummaryCatalog`: Hook to load catalog metadata for a route.
 *
 * The catalog itself is in `@reformaflow/domain` (summary-catalog.ts).
 */

export { getIconComponent, SummaryPageHeader } from './SummaryPageHeader';
export type { SummaryPageHeaderProps } from './SummaryPageHeader';

export { SummaryCTASection } from './SummaryCTASection';
export type { SummaryCTASectionProps } from './SummaryCTASection';

export { useSummaryCatalog } from './useSummaryCatalog';
