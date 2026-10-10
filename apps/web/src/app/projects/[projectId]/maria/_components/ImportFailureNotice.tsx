import type { ImportFailureInfo } from '../_lib/import-session-errors';

const BUTTON =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-lifeone-hairline bg-white px-4 text-[14px] font-semibold text-lifeone-ink';

/** Failure is always visible: fixed copy plus an action, never silence or an empty list. */
export function ImportFailureNotice({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div role="alert" className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[14px] text-amber-900">
      <p>{message}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className={BUTTON}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function noticeFromInfo(info: ImportFailureInfo, onRetry?: () => void) {
  return (
    <ImportFailureNotice
      message={info.message}
      actionLabel={info.retryable && onRetry ? 'Tentar de novo' : undefined}
      onAction={onRetry}
    />
  );
}
