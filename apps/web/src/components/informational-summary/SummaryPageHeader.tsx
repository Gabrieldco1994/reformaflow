'use client';

import { SummaryPageDef } from '@reformaflow/domain';
import { LucideProps } from 'lucide-react';
import dynamic from 'next/dynamic';

// Dynamic icon loading to avoid bundling all lucide icons at once
const LUCIDE_ICONS: Record<string, React.ComponentType<LucideProps>> = {
  BarChart3: dynamic(() => import('lucide-react').then((m) => ({ default: m.BarChart3 }))),
  ArrowLeftRight: dynamic(() =>
    import('lucide-react').then((m) => ({ default: m.ArrowLeftRight })),
  ),
  Tags: dynamic(() => import('lucide-react').then((m) => ({ default: m.Tags }))),
  FlaskConical: dynamic(() =>
    import('lucide-react').then((m) => ({ default: m.FlaskConical })),
  ),
  Gauge: dynamic(() => import('lucide-react').then((m) => ({ default: m.Gauge }))),
  Eye: dynamic(() => import('lucide-react').then((m) => ({ default: m.Eye }))),
  Landmark: dynamic(() => import('lucide-react').then((m) => ({ default: m.Landmark }))),
  Target: dynamic(() => import('lucide-react').then((m) => ({ default: m.Target }))),
  Shuffle: dynamic(() => import('lucide-react').then((m) => ({ default: m.Shuffle }))),
  Calculator: dynamic(() => import('lucide-react').then((m) => ({ default: m.Calculator }))),
  Wallet: dynamic(() => import('lucide-react').then((m) => ({ default: m.Wallet }))),
  Repeat: dynamic(() => import('lucide-react').then((m) => ({ default: m.Repeat }))),
  CalendarClock: dynamic(() =>
    import('lucide-react').then((m) => ({ default: m.CalendarClock })),
  ),
  Link: dynamic(() => import('lucide-react').then((m) => ({ default: m.Link }))),
  Plus: dynamic(() => import('lucide-react').then((m) => ({ default: m.Plus }))),
  ChevronLeft: dynamic(() => import('lucide-react').then((m) => ({ default: m.ChevronLeft }))),
  Search: dynamic(() => import('lucide-react').then((m) => ({ default: m.Search }))),
  DownloadCloud: dynamic(() =>
    import('lucide-react').then((m) => ({ default: m.DownloadCloud })),
  ),
  Upload: dynamic(() => import('lucide-react').then((m) => ({ default: m.Upload }))),
  Edit: dynamic(() => import('lucide-react').then((m) => ({ default: m.Edit }))),
  Car: dynamic(() => import('lucide-react').then((m) => ({ default: m.Car }))),
  CreditCard: dynamic(() => import('lucide-react').then((m) => ({ default: m.CreditCard }))),
  FileText: dynamic(() => import('lucide-react').then((m) => ({ default: m.FileText }))),
  Wrench: dynamic(() => import('lucide-react').then((m) => ({ default: m.Wrench }))),
  Bell: dynamic(() => import('lucide-react').then((m) => ({ default: m.Bell }))),
  Sprout: dynamic(() => import('lucide-react').then((m) => ({ default: m.Sprout }))),
  ScanSearch: dynamic(() => import('lucide-react').then((m) => ({ default: m.ScanSearch }))),
  Camera: dynamic(() => import('lucide-react').then((m) => ({ default: m.Camera }))),
};

/**
 * Safely resolve a lucide icon by name. Falls back to null if not found.
 * Avoids importing every icon upfront.
 */
export function getIconComponent(
  iconName?: string,
): React.ComponentType<LucideProps> | null {
  if (!iconName) return null;
  return LUCIDE_ICONS[iconName] ?? null;
}

export interface SummaryPageHeaderProps {
  pageData: SummaryPageDef;
  children?: React.ReactNode;
}

/**
 * Generic informational page header for summary screens.
 *
 * Displays the page icon (if available), title, description, and any additional
 * children (e.g., metrics, charts). Consistent layout across dashboards, Cockpit,
 * analytics pages, and other informational routes.
 *
 * Usage:
 * ```tsx
 * <SummaryPageHeader pageData={catalogItem}>
 *   <YourChartOrMetricsHere />
 * </SummaryPageHeader>
 * ```
 */
export function SummaryPageHeader({ pageData, children }: SummaryPageHeaderProps) {
  const IconComponent = getIconComponent(pageData.iconName);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        {IconComponent && (
          <div className="flex-shrink-0 pt-1">
            <IconComponent className="h-8 w-8 text-brand-500" data-testid="page-icon" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            {pageData.title}
          </h1>
          {pageData.description && (
            <p className="mt-2 text-base text-gray-600 dark:text-gray-400">
              {pageData.description}
            </p>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
