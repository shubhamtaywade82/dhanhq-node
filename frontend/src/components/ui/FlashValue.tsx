import { memo, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

interface FlashValueProps {
  value: string | number | boolean | null | undefined;
  type?: 'auto' | 'up-down' | 'neutral';
  className?: string;
  children?: ReactNode;
}

export const FlashValue = memo(function FlashValue({
  value,
  type = 'auto',
  className = '',
  children,
}: FlashValueProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const prevValueRef = useRef<string | number | boolean | null | undefined>(undefined);

  useEffect(() => {
    if (value === undefined || value === null) return;
    const prev = prevValueRef.current;
    prevValueRef.current = value;
    if (prev === undefined || prev === null || prev === value) return;

    const el = spanRef.current;
    if (!el) return;

    let cls = 'animate-flash-neutral';
    if (type !== 'neutral' && typeof value === 'number' && typeof prev === 'number') {
      cls = value > prev ? 'animate-flash-up' : 'animate-flash-down';
    }

    el.classList.remove('animate-flash-up', 'animate-flash-down', 'animate-flash-neutral');
    // Force DOM reflow to restart CSS keyframe animation synchronously
    void el.offsetWidth;
    el.classList.add(cls);
  }, [value, type]);

  return (
    <span ref={spanRef} className={`inline-block rounded px-0.5 transition-colors duration-150 ${className}`}>
      {children !== undefined ? children : (value !== null && value !== undefined ? String(value) : '—')}
    </span>
  );
});
