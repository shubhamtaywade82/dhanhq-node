import { useRef, useEffect } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Select';
import { Trash } from 'lucide-react';

const logColors: Record<string, string> = {
  INFO: 'text-accent',
  WARN: 'text-gold',
  ERROR: 'text-danger',
  TRADE: 'text-purple',
  SYSTEM: 'text-muted',
};

export function Logs() {
  const { state, setState, showToast } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [state.logs]);

  const filtered = state.logFilter === 'all'
    ? state.logs
    : state.logs.filter(l => l.level.toLowerCase() === state.logFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Correlated System Logs</div>
          <div className="text-xs text-muted mt-0.5">Tagged with request_id and execution correlationId</div>
        </div>
        <div className="flex gap-2">
          <Select value={state.logFilter} onChange={(e) => setState(prev => ({ ...prev, logFilter: e.target.value }))} className="text-xs">
            <option value="all">All Levels</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
            <option value="trade">TRADE</option>
          </Select>
          <Button variant="ghost" className="text-xs" onClick={() => { setState(prev => ({ ...prev, logs: [] })); showToast('System logs cleared', 'success'); }}>
            <Trash size={12} className="mr-1" /> Clear
          </Button>
        </div>
      </div>

      <Card className="p-4 h-[calc(100vh-210px)] overflow-y-auto font-mono text-xs space-y-1">
        <div ref={containerRef}>
        {filtered.map((l) => (
          <div key={l.id} className="leading-relaxed">
            <span className="text-muted">{l.time}</span>
            <span className={`${logColors[l.level] || 'text-white'} font-semibold`}> [{l.level.padEnd(5)}]</span>
            <span className="text-muted"> [{l.source}]</span>
            <span className="text-slate-600"> ({l.reqId})</span>
            <span className="text-slate-300"> {l.message}</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center py-8 text-muted">No log entries yet. System logs will appear here.</div>
        )}
        </div>
      </Card>
    </div>
  );
}
