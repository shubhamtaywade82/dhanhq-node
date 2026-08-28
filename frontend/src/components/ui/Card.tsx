import type { ReactNode } from 'react';

export function Card({ children, className = '', ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`bg-surface-100 border border-border rounded-lg transition-all hover:border-[#2a3d5e] ${className}`} {...props}>
      {children}
    </div>
  );
}
