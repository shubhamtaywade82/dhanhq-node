import type { ReactNode, ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'danger' | 'ghost' | 'gold';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-accent text-bg hover:bg-accent-bright',
  danger: 'bg-danger text-white hover:bg-[#ff5c78]',
  ghost: 'bg-transparent text-muted border border-border hover:text-white hover:border-[#2a3d5e] hover:bg-surface-200',
  gold: 'bg-gold text-bg hover:bg-[#fbbf24]',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', children, className = '', ...props }: ButtonProps) {
  return (
    <button
      className={`px-4 py-[7px] rounded-md text-xs font-semibold font-sans transition-all inline-flex items-center justify-center gap-1.5
        active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none
        ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
