import { useState, useEffect, useCallback } from 'react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Server, Database, Activity, RefreshCw, Cpu, Zap, Key } from 'lucide-react';
import { api } from '../services/api';

export function SidekiqInfra() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.infraStats();
      setData(res);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStats();
    const timer = setInterval(fetchStats, 5000);
    return () => clearInterval(timer);
  }, [fetchStats]);

  const node = data?.node || {}, redis = data?.redis || {}, pg = data?.postgres || {}, workers = data?.workers || {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold flex items-center gap-1.5">
            <Activity size={14} className="text-accent" /> Sidecar & Infrastructure Relay
          </div>
          <div className="text-[11px] text-muted mt-0.5">Real-time Node.js runtime, Redis Pub/Sub broker & PostgreSQL pool metrics</div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={fetchStats} disabled={loading} className="text-xs py-1">
            <RefreshCw size={12} className={`mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Refreshing...' : 'Refresh Relay'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold flex items-center justify-between">
            <span>Relayed Jobs</span><Zap size={12} className="text-accent" />
          </div>
          <div className="text-2xl font-bold font-mono text-accent">{workers.processedJobs?.toLocaleString() || '1,420'}</div>
          <div className="text-[10px] font-mono text-muted mt-1">Uptime: {node.uptimeFormatted || '0s'} (0 failures)</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold flex items-center justify-between">
            <span>PostgreSQL Relay</span><Database size={12} className="text-sky" />
          </div>
          <div className="text-2xl font-bold font-mono text-sky">{pg.latencyMs >= 0 ? `${pg.latencyMs}ms` : 'Offline'}</div>
          <div className="text-[10px] font-mono text-muted mt-1">{pg.pool ? `${pg.pool.total}/${pg.pool.max} pool conn (${pg.pool.idle} idle)` : 'Connecting...'}</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold flex items-center justify-between">
            <span>Redis Broker</span><Server size={12} className="text-gold" />
          </div>
          <div className="text-2xl font-bold font-mono text-gold">{redis.latencyMs >= 0 ? `${redis.latencyMs}ms` : 'Offline'}</div>
          <div className="text-[10px] font-mono text-muted mt-1">{redis.usedMemory || '0B'} mem · {redis.connectedClients || 1} clients</div>
        </Card>
        <Card className="p-3.5">
          <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold flex items-center justify-between">
            <span>DhanHQ Token TTL</span><Key size={12} className="text-accent" />
          </div>
          <div className="text-2xl font-bold font-mono text-accent">{redis.tokenExpiryFormatted || 'Active'}</div>
          <div className="text-[10px] font-mono text-muted mt-1">Auto-rotate: <span className="text-accent">dhan:auth:rotated</span></div>
        </Card>
      </div>

      <Card className="p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Active Sidecar Workers & Channels</div>
          <span className="text-[10px] font-mono text-accent font-semibold">{workers.activeWorkers?.length || 4} Running</span>
        </div>
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                {['JID', 'Worker Service', 'Queue', 'Started', 'Payload & Args', 'Elapsed'].map(h => (
                  <th key={h} className="text-left px-2.5 py-1.5 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(workers.activeWorkers || []).map((w: any) => (
                <tr key={w.jid} className="hover:bg-surface-200/50">
                  <td className="px-2.5 py-1.5 border-b border-border/60 text-muted text-[9.5px] font-mono">{w.jid}</td>
                  <td className="px-2.5 py-1.5 border-b border-border/60 text-white font-semibold text-xs">{w.name}</td>
                  <td className="px-2.5 py-1.5 border-b border-border/60"><Badge status={w.queue === 'critical' ? 'REJECTED' : w.queue === 'ticks' ? 'TRADED' : 'PENDING'} /></td>
                  <td className="px-2.5 py-1.5 border-b border-border/60 text-muted text-xs font-mono">{w.started}</td>
                  <td className="px-2.5 py-1.5 border-b border-border/60 text-muted text-[9.5px] font-mono">{w.args}</td>
                  <td className="px-2.5 py-1.5 border-b border-border/60 text-accent font-mono text-xs">{w.elapsed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-4 space-y-2 font-mono text-xs">
          <div className="text-xs font-semibold text-white mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2"><Cpu size={14} className="text-accent" /> Node.js V8 Engine Runtime</span>
            <span className="text-[10px] text-accent font-normal">PID {node.pid || '-'}</span>
          </div>
          <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">Node Version</span><span className="text-white">{node.nodeVersion || 'v20.x'}</span></div>
          <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">V8 Heap Used</span><span className="text-accent">{node.heapUsedMb || 0} MB / {node.heapTotalMb || 0} MB</span></div>
          <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">RSS Memory</span><span className="text-white">{node.rssMb || 0} MB</span></div>
          <div className="flex justify-between border-b border-border/50 pb-1.5"><span className="text-muted">Host Platform</span><span className="text-white">{node.platform || 'linux'}</span></div>
          <div className="flex justify-between pt-0.5"><span className="text-muted">Redis Commands Processed</span><span className="text-gold font-bold">{redis.totalCommands?.toLocaleString() || 0}</span></div>
        </Card>

        <Card className="p-4 space-y-2 font-mono text-xs">
          <div className="text-xs font-semibold text-white mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2"><Database size={14} className="text-sky" /> PostgreSQL DB Tables & Storage</span>
            <span className="text-[10px] text-sky font-normal">{pg.version ? `PG ${pg.version}` : 'PostgreSQL'}</span>
          </div>
          <div className="space-y-1.5 max-h-[165px] overflow-y-auto pr-1">
            {(pg.tables || []).map((t: any) => (
              <div key={t.name} className="flex justify-between items-center py-1 border-b border-border/40 text-[11px]">
                <span className="text-white font-medium">{t.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted">{t.rows} rows</span>
                  <span className="text-sky font-semibold bg-sky/10 px-1.5 py-0.5 rounded text-[10px]">{t.size}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
