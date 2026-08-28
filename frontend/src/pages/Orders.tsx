import { useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { fmt, sideClass } from '../utils/formatters';

export function Orders() {
  const { state } = useApp();
  const [filter, setFilter] = useState('ALL');

  const filtered = filter === 'ALL'
    ? state.orders
    : state.orders.filter(o => o.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Order Book & Audit Trail</div>
          <div className="text-xs text-muted mt-0.5">Full execution history mapped by idempotency key and correlationId</div>
        </div>
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="text-xs">
          <option value="ALL">All Statuses</option>
          <option value="TRADED">TRADED / FILLED</option>
          <option value="PENDING">PENDING / OPEN</option>
          <option value="REJECTED">REJECTED</option>
          <option value="CANCELLED">CANCELLED</option>
        </Select>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px] font-mono">
          <thead>
            <tr>
              {['Order ID', 'Correlation ID', 'Time', 'Instrument', 'Type', 'Side', 'Qty', 'Price', 'Filled', 'Avg Price', 'Leg Type', 'AASM State', 'Sidekiq JID', 'Latency'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((o, i) => (
              <tr key={i} className="hover:bg-surface-200/50">
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">{o.id}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-sky text-[9.5px] font-mono">{o.corr}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.time}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.instrument}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.type}</td>
                <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${sideClass(o.side)}`}>{o.side}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.qty}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{fmt(o.price)}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.filled}/{o.qty}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{o.avg ? fmt(o.avg) : '-'}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60"><Badge status={o.leg === 'ENTRY_LEG' ? 'TRADED' : 'TRANSIT'} /></td>
                <td className="px-2.5 py-[7px] border-b border-border/60"><Badge status={o.status} /></td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[9px]">{o.jid}</td>
                <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.latency}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
