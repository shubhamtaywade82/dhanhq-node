import type { InputHTMLAttributes } from 'react';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`bg-bg border border-border rounded-md px-3 py-[7px] text-[12px] font-mono text-white outline-none transition-border focus:border-accent placeholder:text-[#3b4d6e] w-full ${className}`}
      {...props}
    />
  );
}
