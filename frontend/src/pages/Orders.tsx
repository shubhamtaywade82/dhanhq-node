import { useState } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { fmt, sideClass } from '../utils/formatters';
import { Plus, RotateCcw } from 'lucide-react';
import { api } from '../services/api';

export function Orders() {
  const { state, showToast, openModal, closeModal, addSystemLog, refreshPortfolio } = useApp();
  const [filter, setFilter] = useState('ALL');

  const filtered = filter === 'ALL'
    ? state.orders
    : state.orders.filter(o => o.status === filter);

  const openPlaceOrderModal = () => {
    let sym = 'NIFTY24JAN24250CE';
    let side: 'BUY' | 'SELL' = 'BUY';
    let qty = 50;
    let px = 185.5;
    let prod = 'INTRADAY';

    openModal(
      <div className="space-y-3">
        <div className="text-sm font-bold text-white mb-2">Place Paper Order (Instant Fill Simulation)</div>
        <div>
          <label className="text-[10px] font-mono text-muted uppercase block mb-1">Symbol / Instrument</label>
          <Input defaultValue={sym} onChange={(e) => { sym = e.target.value; }} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Side</label>
            <Select defaultValue="BUY" onChange={(e) => { side = e.target.value as 'BUY' | 'SELL'; }}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </Select>
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Quantity</label>
            <Input type="number" defaultValue={qty} onChange={(e) => { qty = Number(e.target.value); }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Simulated Price (₹)</label>
            <Input type="number" defaultValue={px} onChange={(e) => { px = Number(e.target.value); }} />
          </div>
          <div>
            <label className="text-[10px] font-mono text-muted uppercase block mb-1">Product</label>
            <Select defaultValue="INTRADAY" onChange={(e) => { prod = e.target.value; }}>
              <option value="INTRADAY">INTRADAY</option>
              <option value="MARGIN">MARGIN</option>
            </Select>
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button onClick={async () => {
            try {
              closeModal();
              const res = await api.placePaperOrder({
                symbol: sym,
                quantity: qty,
                transactionType: side,
                price: px,
                productType: prod,
              });
              showToast(`Paper Order Filled: ${side} ${qty}x ${sym} @ ₹${res.fillPrice || px}`, 'success');
              addSystemLog('INFO', `Paper Order ${res.orderId} executed for ${sym}`, 'paper_execution');
              await refreshPortfolio();
            } catch (e: any) {
              showToast(`Order failed: ${e.message}`, 'error');
            }
          }}>Execute Order</Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Order Book & Audit Trail</div>
          <div className="text-xs text-muted mt-0.5">PostgreSQL persisted audit log of paper trading executions</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={async () => { await refreshPortfolio(); showToast('Orders synced with database', 'success'); }}>
            <RotateCcw size={12} className="mr-1" /> Refresh
          </Button>
          <Button onClick={openPlaceOrderModal}>
            <Plus size={14} className="mr-1" /> Place Paper Order
          </Button>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="text-xs">
            <option value="ALL">All Statuses</option>
            <option value="TRADED">TRADED / FILLED</option>
            <option value="PENDING">PENDING / OPEN</option>
            <option value="REJECTED">REJECTED</option>
            <option value="CANCELLED">CANCELLED</option>
          </Select>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              {['Order ID', 'Correlation ID', 'Time', 'Instrument', 'Type', 'Side', 'Qty', 'Price', 'Filled', 'Avg Price', 'Status', 'Latency'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="text-center py-8 text-muted text-xs">No orders recorded. Click &quot;Place Paper Order&quot; to execute your first paper trade!</td>
              </tr>
            ) : (
              filtered.map((o, i) => (
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
                  <td className="px-2.5 py-[7px] border-b border-border/60"><Badge status={o.status} /></td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{o.latency}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
