// The site's wordmark (its name from industry/site.ts, set in type) and a small ring mark used as the
// loader. A site with its own logo can replace Wordmark here.
import { SITE } from "@aihot/industry/site";

export function Wordmark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: size }} aria-label={SITE.name} role="img">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="mr-[0.28em] size-[1em] shrink-0 text-accent" fill="none">
        <path d="M19.5 7.5 12 3 4.5 7.5v9L12 21l7.5-4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M12 12h7.5M12 12l-4.5-3M12 12l-4.5 3" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="2.6" fill="currentColor" />
        <circle cx="19.5" cy="12" r="1.7" fill="currentColor" />
      </svg>
      <span aria-hidden="true">{SITE.name}</span>
    </span>
  );
}

/** CoreScope's scope mark also acts as a quiet activity indicator. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
