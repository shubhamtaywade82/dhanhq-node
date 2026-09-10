import { useRef, useEffect, useMemo } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { Trash } from 'lucide-react';
import type { LogEntry } from '../store/types';

const logColors: Record<string, string> = {
  INFO: 'text-accent',
  WARN: 'text-gold',
  ERROR: 'text-danger',
  TRADE: 'text-purple',
  SYSTEM: 'text-muted',
};

const IMPORTANT_LEVELS = new Set(['WARN', 'ERROR', 'TRADE', 'SYSTEM']);

function matchesFilter(level: string, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'important') return IMPORTANT_LEVELS.has(level);
  return level.toLowerCase() === filter;
}

type CollapsedLog = { entry: LogEntry; count: number };

function collapseConsecutive(logs: LogEntry[]): CollapsedLog[] {
  const out: CollapsedLog[] = [];
  for (const entry of logs) {
    const prev = out[out.length - 1];
    const key = `${entry.level}|${entry.source}|${entry.message}`;
    const prevKey = prev ? `${prev.entry.level}|${prev.entry.source}|${prev.entry.message}` : '';
    if (prev && key === prevKey) prev.count += 1;
    else out.push({ entry, count: 1 });
  }
  return out;
}

export function Logs() {
  const { state, setState, showToast } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => state.logs.filter((l) => matchesFilter(l.level, state.logFilter)),
    [state.logs, state.logFilter],
  );
  const display = useMemo(() => collapseConsecutive(filtered), [filtered]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [display]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Correlated System Logs</div>
          <div className="text-xs text-muted mt-0.5">Important events by default — duplicates collapsed</div>
        </div>
        <div className="flex gap-2">
          <Select value={state.logFilter} onChange={(e) => setState(prev => ({ ...prev, logFilter: e.target.value }))} className="text-xs">
            <option value="important">Important</option>
            <option value="all">All Levels</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
            <option value="trade">TRADE</option>
            <option value="system">SYSTEM</option>
          </Select>
          <Button variant="ghost" className="text-xs" onClick={() => { setState(prev => ({ ...prev, logs: [] })); showToast('System logs cleared', 'success'); }}>
            <Trash size={12} className="mr-1" /> Clear
          </Button>
        </div>
      </div>

      <Card className="p-4 h-[calc(100vh-210px)] overflow-y-auto font-mono text-xs space-y-1">
        <div ref={containerRef}>
        {display.map(({ entry: l, count }) => (
          <div key={l.id} className="leading-relaxed">
            <span className="text-muted">{l.time}</span>
            <span className={`${logColors[l.level] || 'text-white'} font-semibold`}> [{l.level.padEnd(5)}]</span>
            <span className="text-muted"> [{l.source}]</span>
            {l.reqId !== '-' && <span className="text-slate-600"> ({l.reqId})</span>}
            <span className="text-slate-300"> {l.message}</span>
            {count > 1 && <span className="text-muted"> ×{count}</span>}
          </div>
        ))}
        {display.length === 0 && (
          <div className="text-center py-8 text-muted">No log entries yet. System logs will appear here.</div>
        )}
        </div>
      </Card>
    </div>
  );
}
