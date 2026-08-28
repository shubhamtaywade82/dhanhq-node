import type { SelectHTMLAttributes } from 'react';

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`bg-bg border border-border rounded-md px-2.5 py-[7px] pr-7 text-[12px] font-sans text-white outline-none cursor-pointer appearance-none
        bg-[url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")]
        bg-no-repeat bg-[right_8px_center] transition-border focus:border-accent ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}
