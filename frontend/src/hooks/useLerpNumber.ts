import { useState, useEffect, useRef } from 'react';

/**
 * useLerpNumber
 * Smoothly interpolates (LERP) from previous value to new target value using requestAnimationFrame.
 *
 * @param targetValue The incoming dynamic numerical value.
 * @param factor LERP damping factor (default: 0.18 for smooth ~150-200ms ease-out glide).
 * @param precision Stop threshold (default: 0.01).
 */
export function useLerpNumber(targetValue: number | undefined | null, factor = 0.18, precision = 0.01): number {
  const target = typeof targetValue === 'number' && !isNaN(targetValue) ? targetValue : 0;
  const [displayValue, setDisplayValue] = useState<number>(target);
  const currentRef = useRef<number>(target);
  const targetRef = useRef<number>(target);
  const rafRef = useRef<number | null>(null);

  targetRef.current = target;

  useEffect(() => {
    // If target value matches current within precision threshold, snap and exit.
    if (Math.abs(currentRef.current - target) <= precision) {
      currentRef.current = target;
      setDisplayValue(target);
      return;
    }

    const animate = () => {
      const diff = targetRef.current - currentRef.current;
      if (Math.abs(diff) < precision) {
        currentRef.current = targetRef.current;
        setDisplayValue(targetRef.current);
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        return;
      }

      currentRef.current += diff * factor;
      setDisplayValue(currentRef.current);
      rafRef.current = requestAnimationFrame(animate);
    };

    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, factor, precision]);

  return displayValue;
}
