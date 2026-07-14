export function LifeOneLogo({ compact = false }: { compact?: boolean }) {
  const size = compact ? 36 : 44;
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="lifeone-logo-tile" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
            <stop stopColor="#1E7BFF" />
            <stop offset="1" stopColor="#0A5AD0" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="46" height="46" rx="13" fill="url(#lifeone-logo-tile)" />
        <path d="M12 31 L20 23 L27 27 L35 15" fill="none" stroke="#FFFFFF" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="35" cy="15" r="4.2" fill="#FFFFFF" />
        <circle cx="35" cy="15" r="2.1" fill="#0A6CF0" />
      </svg>
      <span className={`${compact ? 'text-[23px]' : 'text-[28px]'} font-geist font-bold tracking-[-0.03em] text-lifeone-ink`}>
        Life<span className="text-lifeone-blue">One</span>
      </span>
    </div>
  );
}
