import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectType } from '@reformaflow/domain';
import { SummaryPageHeader } from './SummaryPageHeader';
import { SummaryCTASection } from './SummaryCTASection';

describe('informational-summary components', () => {
  describe('SummaryPageHeader', () => {
    it('renders page title and description', () => {
      const pageData = {
        slug: 'dashboard',
        title: 'Dashboard',
        description: 'Visão geral do projeto',
        ctas: [],
      };

      render(<SummaryPageHeader pageData={pageData} />);

      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Visão geral do projeto')).toBeInTheDocument();
    });

    it('renders only title if description is absent', () => {
      const pageData = {
        slug: 'test',
        title: 'Test Page',
        ctas: [],
      };

      render(<SummaryPageHeader pageData={pageData} />);

      expect(screen.getByText('Test Page')).toBeInTheDocument();
      expect(screen.queryByText(/Visão geral/)).not.toBeInTheDocument();
    });

    it('renders children when provided', () => {
      const pageData = {
        slug: 'dashboard',
        title: 'Dashboard',
        ctas: [],
      };

      render(
        <SummaryPageHeader pageData={pageData}>
          <div data-testid="child-content">Child Content</div>
        </SummaryPageHeader>,
      );

      expect(screen.getByTestId('child-content')).toBeInTheDocument();
    });

    it('applies heading semantic elements', () => {
      const pageData = {
        slug: 'dashboard',
        title: 'Dashboard',
        ctas: [],
      };

      const { container } = render(<SummaryPageHeader pageData={pageData} />);
      const h1 = container.querySelector('h1');

      expect(h1).toBeInTheDocument();
      expect(h1?.textContent).toBe('Dashboard');
    });
  });

  describe('SummaryCTASection', () => {
    it('renders CTA buttons with labels', () => {
      const ctas = [
        { label: 'Add Item', href: '/items/new', variant: 'primary' as const },
        { label: 'Learn More', href: '/help', variant: 'ghost' as const },
      ];

      render(<SummaryCTASection ctas={ctas} />);

      expect(screen.getByText('Add Item')).toBeInTheDocument();
      expect(screen.getByText('Learn More')).toBeInTheDocument();
    });

    it('renders nothing when ctas array is empty', () => {
      const { container } = render(<SummaryCTASection ctas={[]} />);

      expect(container.firstChild).toBeNull();
    });

    it('renders CTAs as links with correct hrefs', () => {
      const ctas = [
        { label: 'New Expense', href: 'expenses/new', variant: 'primary' as const },
      ];

      render(<SummaryCTASection ctas={ctas} />);

      const link = screen.getByRole('link', { name: /New Expense/ });
      expect(link).toHaveAttribute('href', 'expenses/new');
    });

    it('applies variant-specific styling classes', () => {
      const ctas = [
        { label: 'Primary', href: '#', variant: 'primary' as const },
        { label: 'Secondary', href: '#', variant: 'secondary' as const },
        { label: 'Outline', href: '#', variant: 'outline' as const },
      ];

      const { container } = render(<SummaryCTASection ctas={ctas} />);
      const buttons = container.querySelectorAll('a');

      expect(buttons[0]).toHaveClass('bg-brand-600', 'text-white');
      expect(buttons[1]).toHaveClass('bg-gray-100');
      expect(buttons[2]).toHaveClass('border', 'border-gray-300');
    });

    it('renders CTA section wrapper with testid', () => {
      const ctas = [{ label: 'Test', href: '#', variant: 'primary' as const }];

      render(<SummaryCTASection ctas={ctas} />);

      expect(screen.getByTestId('cta-section')).toBeInTheDocument();
    });

    it('applies custom className prop', () => {
      const ctas = [{ label: 'Test', href: '#' }];
      const customClass = 'custom-grid grid-cols-2';

      const { container } = render(<SummaryCTASection ctas={ctas} className={customClass} />);
      const wrapper = container.querySelector('[data-testid="cta-section"]');

      expect(wrapper).toHaveClass('custom-grid', 'grid-cols-2');
    });

    it('renders CTA buttons with data-testid for automation', () => {
      const ctas = [
        { label: 'First', href: '#' },
        { label: 'Second', href: '#' },
      ];

      render(<SummaryCTASection ctas={ctas} />);

      expect(screen.getByTestId('cta-button-0')).toBeInTheDocument();
      expect(screen.getByTestId('cta-button-1')).toBeInTheDocument();
    });
  });

  describe('integration: SummaryPageHeader + SummaryCTASection', () => {
    it('can render both header and CTA section together', () => {
      const pageData = {
        slug: 'dashboard',
        title: 'Dashboard',
        description: 'View summary',
        ctas: [{ label: 'Add', href: '/new', variant: 'primary' as const }],
      };

      render(
        <SummaryPageHeader pageData={pageData}>
          <SummaryCTASection ctas={pageData.ctas} />
        </SummaryPageHeader>,
      );

      expect(screen.getByText('Dashboard')).toBeInTheDocument();
      expect(screen.getByText('View summary')).toBeInTheDocument();
      expect(screen.getByText('Add')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('SummaryPageHeader uses semantic heading', () => {
      const pageData = {
        slug: 'dashboard',
        title: 'Dashboard',
        ctas: [],
      };

      const { container } = render(<SummaryPageHeader pageData={pageData} />);
      const h1 = container.querySelector('h1');

      expect(h1).toBeInTheDocument();
    });

    it('SummaryCTASection uses semantic link elements', () => {
      const ctas = [{ label: 'Go to item', href: 'items/123' }];

      render(<SummaryCTASection ctas={ctas} />);

      const link = screen.getByRole('link', { name: /Go to item/ });
      expect(link).toBeInTheDocument();
    });

    it('CTA buttons have accessible names', () => {
      const ctas = [{ label: 'Create New Item', href: '/items/new' }];

      render(<SummaryCTASection ctas={ctas} />);

      const button = screen.getByRole('link', { name: /Create New Item/ });
      expect(button).toHaveAccessibleName('Create New Item');
    });
  });
});
