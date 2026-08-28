export const fmt = (n: number, d = 2): string =>
  Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

export const fmtINR = (n: number): string =>
  (n >= 0 ? '+' : '') + fmt(Math.abs(n), 0);

export const pnlClass = (n: number): string =>
  n >= 0 ? 'text-accent' : 'text-danger';

export const sideClass = (s: string): string =>
  s === 'BUY' ? 'text-accent' : 'text-danger';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
