import type { ReactNode } from "react";
export function PillToggles({ items, selected, onChange, label }: { items: Array<{ key: string; label: ReactNode }>; selected: string[]; onChange: (selected: string[]) => void; label: string; layoutId?: string; size?: string; className?: string }) {
  return <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-full bg-well p-1">{items.map(item => <button key={item.key} type="button" aria-pressed={selected.includes(item.key)} onClick={() => onChange(selected.includes(item.key) ? selected.filter(k => k !== item.key) : [...selected, item.key])} className={`min-h-10 rounded-full px-3 text-sm ${selected.includes(item.key) ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-3"}`}>{item.label}</button>)}</div>;
}
