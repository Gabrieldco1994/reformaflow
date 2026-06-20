import { cn } from '@/lib/utils';

interface SkeletonLineProps {
  className?: string;
}

interface SkeletonListProps {
  rows?: number;
  className?: string;
}

export function SkeletonLine({ className }: SkeletonLineProps) {
  return <div className={cn('h-4 animate-pulse rounded bg-darc-linen/60', className)} />;
}

export function SkeletonCard({ className }: SkeletonLineProps) {
  return (
    <div className={cn('rounded-2xl border border-darc-linen bg-white p-4 shadow-darc-soft', className)}>
      <SkeletonLine className="h-5 w-40" />
      <SkeletonLine className="mt-3 w-full max-w-sm" />
      <SkeletonLine className="mt-4 h-8 w-28" />
    </div>
  );
}

export function SkeletonList({ rows = 3, className }: SkeletonListProps) {
  return (
    <div className={cn('grid gap-3', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}
