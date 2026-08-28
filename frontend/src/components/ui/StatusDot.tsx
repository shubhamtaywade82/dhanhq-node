export function StatusDot({ status, pulse = false }: { status: 'live' | 'warn' | 'error' | 'idle'; pulse?: boolean }) {
  const classes: Record<string, string> = {
    live: 'bg-accent shadow-[0_0_6px_var(--color-accent)]',
    warn: 'bg-gold shadow-[0_0_6px_var(--color-gold)]',
    error: 'bg-danger shadow-[0_0_6px_var(--color-danger)]',
    idle: 'bg-muted',
  };
  return (
    <span className={`w-[7px] h-[7px] rounded-full inline-block flex-shrink-0 ${classes[status]} ${pulse ? 'pulse-live' : ''}`} />
  );
}
