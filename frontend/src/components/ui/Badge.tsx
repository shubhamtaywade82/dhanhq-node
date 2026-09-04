import { useEffect, useRef } from 'react';

const badgeMap: Record<string, string> = {
  TRADED: 'bg-accent/12 text-accent',
  FILLED: 'bg-accent/12 text-accent',
  PENDING: 'bg-sky/12 text-sky',
  OPEN: 'bg-sky/12 text-sky',
  REJECTED: 'bg-danger/12 text-danger',
  CANCELLED: 'bg-muted/12 text-muted',
  TRANSIT: 'bg-gold/12 text-gold',
};

export function Badge({ status, className = '', flash = true }: { status: string; className?: string; flash?: boolean }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const prevRef = useRef<string>(status);

  useEffect(() => {
    if (!flash) return;
    const prev = prevRef.current;
    prevRef.current = status;
    if (!prev || prev === status) return;
    const el = spanRef.current;
    if (!el) return;

    const cls = status === 'FILLED' || status === 'TRADED' ? 'animate-flash-up' : status === 'REJECTED' ? 'animate-flash-down' : 'animate-flash-neutral';
    el.classList.remove('animate-flash-up', 'animate-flash-down', 'animate-flash-neutral');
    void el.offsetWidth;
    el.classList.add(cls);
  }, [status, flash]);

  return (
    <span
      ref={spanRef}
      className={`inline-flex items-center px-1.75 py-0.5 rounded text-[9.5px] font-mono font-semibold whitespace-nowrap transition-colors duration-150 ${badgeMap[status] || 'bg-muted/12 text-muted'} ${className}`}
    >
      {status}
    </span>
  );
}

export function StratBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; cls: string; pulse: boolean }> = {
    RUNNING: { dot: 'bg-accent shadow-[0_0_6px_var(--color-accent)]', cls: 'text-accent', pulse: true },
    MONITORING: { dot: 'bg-sky shadow-[0_0_6px_var(--color-sky)]', cls: 'text-sky', pulse: true },
    READY: { dot: 'bg-sky shadow-[0_0_6px_var(--color-sky)]', cls: 'text-sky', pulse: true },
    PAUSED: { dot: 'bg-gold shadow-[0_0_6px_var(--color-gold)]', cls: 'text-gold', pulse: false },
    STOPPED: { dot: 'bg-muted', cls: 'text-muted', pulse: false },
  };
  const s = map[status] || map.STOPPED;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${s.dot} ${s.pulse ? 'pulse-live' : ''}`} />
      <span className={`${s.cls} text-[10px] font-mono font-semibold`}>{status}</span>
    </span>
  );
}
