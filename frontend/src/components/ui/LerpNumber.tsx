import { memo, useEffect, useRef } from 'react';
import { useLerpNumber } from '../../hooks/useLerpNumber';
import { fmt } from '../../utils/formatters';

interface LerpNumberProps {
  value: number | undefined | null;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  format?: (n: number) => string;
  flash?: boolean;
}

export const LerpNumber = memo(function LerpNumber({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  className = '',
  format,
  flash = true,
}: LerpNumberProps) {
  const precision = Math.pow(10, -Math.max(1, decimals));
  const animatedValue = useLerpNumber(value, 0.18, precision);
  const spanRef = useRef<HTMLSpanElement>(null);
  const prevValueRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (!flash || value === undefined || value === null || isNaN(value)) return;
    const prev = prevValueRef.current;
    prevValueRef.current = value;
    if (prev === undefined || prev === null || prev === value) return;

    const el = spanRef.current;
    if (!el) return;

    const cls = value > prev ? 'animate-flash-up' : 'animate-flash-down';
    el.classList.remove('animate-flash-up', 'animate-flash-down', 'animate-flash-neutral');
    // Force DOM reflow so subsequent ticks in same direction restart animation
    void el.offsetWidth;
    el.classList.add(cls);
  }, [value, flash]);

  if (value === undefined || value === null || isNaN(value)) {
    return <span className={className}>—</span>;
  }

  const formatted = format ? format(animatedValue) : fmt(animatedValue, decimals);

  return (
    <span
      ref={spanRef}
      className={`inline-block tabular-nums rounded px-0.5 transition-colors duration-150 ${className}`}
    >
      {prefix}{formatted}{suffix}
    </span>
  );
});

