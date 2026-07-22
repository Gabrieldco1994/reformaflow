'use client';

export function LoadingBlock() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_20rem]">
        <div className="h-36 rounded-3xl bg-lifeone-surface" />
        <div className="h-36 rounded-3xl bg-lifeone-surface" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-28 rounded-2xl bg-lifeone-surface" />
        ))}
      </div>
      <div className="h-64 rounded-3xl bg-lifeone-surface" />
    </div>
  );
}
