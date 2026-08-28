import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Server, Database } from 'lucide-react';

export function SidekiqInfra() {
  const { state } = useApp();

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Processed Jobs</div>
          <div className="text-2xl font-bold font-mono text-accent">1,247</div>
          <div className="text-[10px] font-mono text-muted mt-1">Since 09:15 IST (0 failures)</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Failed / Retried</div>
          <div className="text-2xl font-bold font-mono text-danger">{state.skRetries.length}</div>
          <div className="text-[10px] font-mono text-muted mt-1">{state.skRetries.length} in retry set, 0 dead</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Busy Workers</div>
          <div className="text-2xl font-bold font-mono text-gold">12</div>
          <div className="text-[10px] font-mono text-muted mt-1">of 25 concurrency threads</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">Redis Adapter</div>
          <div className="text-2xl font-bold font-mono text-sky">0.4ms</div>
          <div className="text-[10px] font-mono text-muted mt-1">3 ActionCable channels</div>
        </Card>
      </div>

      <Card className="p-4 space-y-2.5">
        <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Active Sidekiq Workers</div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px] font-mono">
            <thead>
              <tr>
                {['JID', 'Worker Class', 'Queue', 'Started', 'Arguments Payload', 'Elapsed'].map(h => (
                  <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.skWorkers.map((w, i) => (
                <tr key={i} className="hover:bg-surface-200/50">
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[9.5px] font-mono">{w.jid}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{w.w}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60"><Badge status={w.q === 'critical' ? 'REJECTED' : w.q === 'ticks' ? 'TRADED' : 'PENDING'} /></td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{w.started}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[9.5px] font-mono">{w.args}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{w.el}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 space-y-2.5">
        <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Sidekiq Retry Set</div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px] font-mono">
            <thead>
              <tr>
                {['JID', 'Worker Class', 'Queue', 'Exception Error', 'Retries', 'Next Execution'].map(h => (
                  <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.skRetries.map((r, i) => (
                <tr key={i} className="hover:bg-surface-200/50">
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[9.5px] font-mono">{r.jid}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{r.w}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60"><Badge status="REJECTED" /></td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-danger text-[10px] font-mono">{r.err}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-gold font-bold">{r.ret}/3</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{r.next}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-2 font-mono text-xs">
          <div className="text-xs font-semibold text-white mb-2 flex items-center gap-2"><Server size={14} className="text-accent" /> Puma 6.4 & Rails Environment</div>
          <div className="flex justify-between"><span className="text-muted">Puma Workers</span><span className="text-white">2 clustered</span></div>
          <div className="flex justify-between"><span className="text-muted">Threads per Worker</span><span className="text-white">5 (10 total)</span></div>
          <div className="flex justify-between"><span className="text-muted">Rails Mode</span><span className="text-accent">production (API-only)</span></div>
          <div className="flex justify-between"><span className="text-muted">ActionCable Adapter</span><span className="text-accent">Redis</span></div>
        </Card>
        <Card className="p-4 space-y-2 font-mono text-xs">
          <div className="text-xs font-semibold text-white mb-2 flex items-center gap-2"><Database size={14} className="text-sky" /> PostgreSQL & Cache Pool</div>
          <div className="flex justify-between"><span className="text-muted">Connection Pool</span><span className="text-white">8 / 20 connections</span></div>
          <div className="flex justify-between"><span className="text-muted">Prepared Statements</span><span className="text-accent">ON</span></div>
          <div className="flex justify-between"><span className="text-muted">Optimistic Locking</span><span className="text-accent">Enabled (lock_version)</span></div>
          <div className="flex justify-between"><span className="text-muted">Solid Queue fallback</span><span className="text-accent">Standby</span></div>
        </Card>
      </div>
    </div>
  );
}
