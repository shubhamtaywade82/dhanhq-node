import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { fmt, fmtINR, pnlClass, sideClass } from '../utils/formatters';
import { RotateCcw, Power } from 'lucide-react';
import { api } from '../services/api';

export function Positions() {
  const { state, showToast, openModal, closeModal, addSystemLog, refreshPortfolio } = useApp();

  const realPositions = state.positions.map((p) => {
    const net = Number(p.netQty ?? p.net_qty ?? 0);
    const buyAvg = Number(p.buyAvg ?? p.buy_avg ?? 0);
    const sellAvg = Number(p.sellAvg ?? p.sell_avg ?? 0);
    const ltp = Number(p.ltp ?? p.costPrice ?? (net >= 0 ? buyAvg : sellAvg));
    const pnl = Number(p.pnl ?? p.realizedProfit ?? 0);

    return {
      id: p.id || p.tradingSymbol,
      strategy: 'Paper Trading',
      instrument: p.tradingSymbol || p.symbol || p.id,
      side: net >= 0 ? ('BUY' as const) : ('SELL' as const),
      qty: Math.abs(net),
      bAvg: buyAvg,
      sAvg: sellAvg,
      ltp,
      pnl,
      delta: '0.00',
      theta: '0',
      product: p.productType || p.product_type || 'INTRADAY',
    };
  });

  const handleClose = async (instrument: string, ltp: number) => {
    try {
      await api.closePaperPosition(instrument, ltp);
      showToast(`Position ${instrument} closed successfully`, 'success');
      addSystemLog('INFO', `Position closed for ${instrument} @ ${ltp}`, 'paper_execution');
      await refreshPortfolio();
    } catch (e: any) {
      showToast(`Failed to close ${instrument}: ${e.message}`, 'error');
    }
  };

  const closeAll = () => {
    openModal(
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-3 text-danger text-xl">
          <Power size={20} />
        </div>
        <div className="text-base font-bold text-danger mb-1">Close All Positions</div>
        <div className="text-xs text-muted mb-4">This will immediately send market orders to close ALL open paper positions.</div>
        <div className="flex gap-2 justify-center">
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button variant="danger" onClick={async () => {
            closeModal();
            for (const p of realPositions) {
              await api.closePaperPosition(p.instrument, p.ltp);
            }
            await refreshPortfolio();
            addSystemLog('WARN', 'All paper positions flushed and closed', 'risk_engine');
            showToast('All open positions closed', 'success');
          }}>Close All Now</Button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">Active Positions & MTM</div>
          <div className="text-xs text-muted mt-0.5">PostgreSQL persistent paper positions with real-time P&L tracking</div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={async () => { await refreshPortfolio(); showToast('Portfolio synced with database', 'success'); }}><RotateCcw size={12} className="mr-1" /> Refresh Positions</Button>
          <Button variant="danger" onClick={closeAll}><Power size={12} className="mr-1" /> Close All Positions</Button>
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {['Strategy', 'Instrument', 'Side', 'Net Qty', 'Buy Avg', 'Sell Avg', 'LTP', 'P&L', 'Product', 'Actions'].map(h => (
                <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {realPositions.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-8 text-muted text-xs">No open positions. Place a paper trade to start!</td>
              </tr>
            ) : (
              realPositions.map((p, i) => (
                <tr key={i} className="hover:bg-surface-200/50">
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted text-[10px]">{p.strategy}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{p.instrument}</td>
                  <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${sideClass(p.side)}`}>{p.side}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">{p.qty}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{p.bAvg ? fmt(p.bAvg) : '-'}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white">{p.sAvg ? fmt(p.sAvg) : '-'}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">{fmt(p.ltp)}</td>
                  <td className={`px-2.5 py-[7px] border-b border-border/60 font-bold ${pnlClass(p.pnl)}`}>{fmtINR(p.pnl)}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">{p.product}</td>
                  <td className="px-2.5 py-[7px] border-b border-border/60">
                    <Button variant="danger" className="text-[9px] px-2 py-0.5" onClick={() => handleClose(p.instrument, p.ltp)}>Close</Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
