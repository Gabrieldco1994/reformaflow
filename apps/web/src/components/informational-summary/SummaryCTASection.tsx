'use client';

import { SummaryCTA } from '@reformaflow/domain';
import Link from 'next/link';
import { getIconComponent } from './SummaryPageHeader';

export interface SummaryCTASectionProps {
  /** Array of CTAs to display. */
  ctas: SummaryCTA[];
  /** Optional CSS class for container customization. */
  className?: string;
}

/**
 * Map CTA variant to semantic button styling.
 * Uses project's existing tailwind semantic classes (brand-*, darc-*).
 */
function getButtonClasses(variant?: SummaryCTA['variant']): string {
  const baseClasses =
    'inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all text-sm';

  switch (variant) {
    case 'primary':
      return `${baseClasses} bg-brand-600 text-white hover:bg-brand-700`;
    case 'secondary':
      return `${baseClasses} bg-gray-100 text-gray-900 hover:bg-gray-200`;
    case 'outline':
      return `${baseClasses} border border-gray-300 text-gray-700 hover:bg-gray-50`;
    case 'ghost':
    default:
      return `${baseClasses} text-gray-600 hover:text-gray-900 hover:bg-gray-50`;
  }
}

/**
 * Generic CTA section for informational summary pages.
 *
 * Renders a group of call-to-action buttons/links, each with optional icon,
 * label, and href. Automatically maps CTA variant to semantic styling.
 *
 * Usage:
 * ```tsx
 * <SummaryCTASection
 *   ctas={[
 *     { label: 'Add item', iconName: 'Plus', href: 'items/new', variant: 'primary' },
 *     { label: 'Learn more', href: '/help', variant: 'ghost' },
 *   ]}
 * />
 * ```
 */
export function SummaryCTASection({
  ctas,
  className = 'flex flex-wrap gap-3',
}: SummaryCTASectionProps) {
  if (ctas.length === 0) {
    return null;
  }

  return (
    <div className={className} data-testid="cta-section">
      {ctas.map((cta, index) => {
        const IconComponent = getIconComponent(cta.iconName);
        const buttonClasses = getButtonClasses(cta.variant);

        return (
          <Link
            key={`${cta.href}-${index}`}
            href={cta.href}
            className={buttonClasses}
            data-testid={`cta-button-${index}`}
          >
            {IconComponent && (
              <IconComponent className="h-4 w-4" data-testid={`cta-icon-${index}`} />
            )}
            <span>{cta.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
