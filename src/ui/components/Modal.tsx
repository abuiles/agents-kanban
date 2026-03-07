import type { ReactNode } from 'react';

export function Modal({
  title,
  children,
  onClose,
  closeLabel = 'Close',
  className
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/88 p-4 backdrop-blur-md sm:p-6" onClick={onClose}>
      <div
        className={`flex max-h-[calc(100vh-3rem)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-slate-700/70 bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(2,6,23,0.98))] shadow-[0_28px_120px_rgba(2,6,23,0.82)] ${className ?? ''}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-800/80 bg-slate-950/55 px-6 py-5 backdrop-blur">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-300/70">Control room action</p>
            <h2 className="mt-2 text-[1.35rem] font-semibold tracking-tight text-white">{title}</h2>
          </div>
          <button
            type="button"
            className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/90 px-4 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
            onClick={onClose}
          >
            {closeLabel}
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
