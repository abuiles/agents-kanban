import type { ReactNode } from 'react';

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/95 shadow-[0_24px_80px_rgba(2,6,23,0.75)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Control room action</p>
            <h2 className="mt-1 text-xl font-semibold text-white">{title}</h2>
          </div>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-4 text-sm font-medium text-slate-200 transition hover:border-slate-500"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
