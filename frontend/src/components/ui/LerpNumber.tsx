import { memo } from 'react';
import { useLerpNumber } from '../../hooks/useLerpNumber';
import { fmt } from '../../utils/formatters';

interface LerpNumberProps {
  value: number | undefined | null;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  format?: (n: number) => string;
}

export const LerpNumber = memo(function LerpNumber({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  className = '',
  format,
}: LerpNumberProps) {
  const precision = Math.pow(10, -Math.max(1, decimals));
  const animatedValue = useLerpNumber(value, 0.18, precision);

  if (value === undefined || value === null || isNaN(value)) {
    return <span className={className}>—</span>;
  }

  const formatted = format ? format(animatedValue) : fmt(animatedValue, decimals);

  return (
    <span className={`inline-block tabular-nums transition-colors duration-150 ${className}`}>
      {prefix}{formatted}{suffix}
    </span>
  );
});
