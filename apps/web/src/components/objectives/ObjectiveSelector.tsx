import { Check } from 'lucide-react';
import { TypeIcon, typeAccent } from '@/app/projects/_components/type-accent';
import { OBJECTIVE_DETAILS, OBJECTIVE_TYPES, type ObjectiveType } from './objective-options';

interface ObjectiveSelectorProps {
  selected: ObjectiveType[];
  onChange: (selected: ObjectiveType[]) => void;
  disabled?: boolean;
  legend?: string;
}

export function ObjectiveSelector({
  selected,
  onChange,
  disabled = false,
  legend = 'Quais objetivos você quer acompanhar?',
}: ObjectiveSelectorProps) {
  const selectedSet = new Set(selected);

  function toggle(type: ObjectiveType) {
    onChange(
      selectedSet.has(type)
        ? selected.filter((item) => item !== type)
        : [...selected, type],
    );
  }

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="relative mt-4 grid min-w-0 gap-3 sm:grid-cols-2" data-testid="objective-constellation">
        <svg className="pointer-events-none absolute inset-8 hidden h-[calc(100%-4rem)] w-[calc(100%-4rem)] sm:block" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d="M10 12 L88 12 L12 50 L88 50 L12 88 L88 88" fill="none" stroke="#DAD5CC" strokeWidth="0.8" strokeDasharray="2 3" />
        </svg>
        {OBJECTIVE_TYPES.map((type) => {
          const details = OBJECTIVE_DETAILS[type];
          const accent = typeAccent(type);
          const checked = selectedSet.has(type);
          const descriptionId = `objective-${type.toLowerCase()}-description`;
          return (
            <label
              key={type}
              className={`relative z-10 flex min-h-[116px] cursor-pointer gap-3 rounded-[16px] border-2 bg-lifeone-card p-4 transition-[border-color,box-shadow,transform] motion-reduce:transition-none ${
                checked
                  ? 'border-lifeone-blue shadow-lifeone-card'
                  : 'border-lifeone-hairline hover:border-lifeone-ink-4'
              } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="checkbox"
                name="projectTypes"
                value={type}
                checked={checked}
                onChange={() => toggle(type)}
                aria-describedby={descriptionId}
                className="mt-1 h-5 w-5 shrink-0 rounded border-lifeone-hairline text-lifeone-blue accent-[#0A6CF0]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]" style={{ backgroundColor: accent.fill }}>
                    <TypeIcon type={type} className="h-5 w-5" style={{ color: accent.color }} />
                  </span>
                  {checked && <Check className="h-5 w-5 shrink-0 text-lifeone-blue" aria-hidden="true" />}
                </span>
                <span className="mt-2 block text-[14px] font-semibold leading-tight text-lifeone-ink">{details.label}</span>
                <span id={descriptionId} className="mt-1 block text-[12px] leading-snug text-lifeone-ink-3">{details.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
