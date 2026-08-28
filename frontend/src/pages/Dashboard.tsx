import { useApp } from "../store/AppContext";
import { Card } from "../components/ui/Card";
import { Badge, StratBadge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { fmt, fmtINR, pnlClass, sideClass } from "../utils/formatters";
import { usePnlChart } from "../hooks/usePnlChart";
import { Plus, Brain } from "lucide-react";

interface DashboardProps {
  onNavigate: (id: string) => void;
  onDeploy: () => void;
}

export function Dashboard({ onNavigate, onDeploy }: DashboardProps) {
  const { state } = useApp();
  const realizedPnl = Number(state.funds.realizedPnl || 0);
  const positionPnl = state.positions.reduce((acc, p) => acc + (Number(p.pnl) || Number(p.realizedProfit) || 0), 0);
  const totalPnl = realizedPnl + positionPnl;
  const canvasRef = usePnlChart(state.pnlHistory.length > 0 ? state.pnlHistory : [0, realizedPnl]);
  const recentOrders = state.orders.slice(0, 8);

  return (
    <div className="dashboard-shell space-y-5">
      <MetricsGrid state={state} totalPnl={totalPnl} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Intraday P&L Performance Curve</span>
              <span className="text-[9px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">REALTIME</span>
            </div>
            <div className="flex gap-1.5">
              <button className="btn btn-ghost text-[10px] py-0.5 px-2.5">1H</button>
              <button className="btn btn-ghost text-[10px] py-0.5 px-2.5 border-accent/30 text-accent">SESSION</button>
              <button className="btn btn-ghost text-[10px] py-0.5 px-2.5">1W</button>
            </div>
          </div>
          <canvas ref={canvasRef} height={190} className="w-full" />
        </Card>
        <Card className="p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3 gap-2">
              <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Active Strategies</span>
              <button className="text-[10px] font-mono text-accent hover:underline whitespace-nowrap" onClick={() => onNavigate("strategies")}>View All →</button>
            </div>
            <div className="space-y-2.5">
              {state.strategies.filter((s) => s.status !== "STOPPED").map((s) => (
                <div key={s.id} className="p-2.5 rounded-lg bg-surface-50 border border-border hover:border-[#2a3d5e] transition-all cursor-pointer" onClick={() => onNavigate("strategies")}>
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <span className="text-[11px] font-semibold text-white truncate min-w-0">{s.name}</span>
                    <StratBadge status={s.status} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-mono text-muted shrink-0">{s.symbol} · {s.type} · {s.lots}L</span>
                    <span className={`text-[11px] font-mono font-bold whitespace-nowrap ${pnlClass(s.pnl)}`}>{fmtINR(s.pnl)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Button className="w-full mt-3" onClick={onDeploy}><Plus size={14} /> Deploy New Strategy</Button>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-3 font-semibold">Market Spot Indices</div>
          <div className="space-y-2.5">
            {Object.entries(state.indices).map(([sym, d]) => {
              if (!d) return null;
              return (
                <div key={sym} className="flex items-center justify-between p-2 rounded bg-surface-50 border border-border">
                  <div>
                    <div className="text-xs font-semibold text-white">{sym}</div>
                    <div className="text-[9px] font-mono text-muted">SPOT</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono font-bold text-white">{fmt(d.ltp)}</div>
                    <div className={`${d.change >= 0 ? "text-accent" : "text-danger"} text-[10px] font-mono`}>
                      {d.change >= 0 ? "▲" : "▼"}{fmt(Math.abs(d.change))} ({fmt(Math.abs(d.pct))}%)
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Recent Order Fills (Audit Stream)</span>
            <button className="text-[10px] font-mono text-accent hover:underline" onClick={() => onNavigate("orders")}>Full Order Book →</button>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {["Time", "Instrument", "Side", "Qty", "Price", "Strategy / Corr ID", "Status"].map((h) => (
                    <th key={h} className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentOrders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-6 text-muted text-xs">No orders recorded yet.</td>
                  </tr>
                ) : (
                  recentOrders.map((f, i) => (
                    <tr key={i} className="hover:bg-surface-200/50">
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">
                        {f.time}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-semibold">
                        {f.instrument}
                      </td>
                      <td
                        className={`px-2.5 py-[7px] border-b border-border/60 font-semibold ${sideClass(f.side)}`}
                      >
                        {f.side}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">
                        {f.qty}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-white font-mono">
                        {fmt(f.price)}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60 text-sky text-[9.5px] font-mono">
                        {f.corr ? f.corr.substring(0, 12) : f.id}
                      </td>
                      <td className="px-2.5 py-[7px] border-b border-border/60">
                        <Badge status={f.status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card className="p-3.5 bg-surface-50 border-purple/20">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-purple">
            <Brain size={14} />
            <span>Real-time Multi-Agent Insights Digest</span>
          </div>
          <span className="text-[9px] font-mono text-muted">
            Auto-updated via Agent Memory
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-[10.5px]">
          {[
            {
              agent: "Planner",
              color: "text-sky",
              text: "Paper execution engine active. Tracking real-time PnL and margin limits via PostgreSQL.",
            },
            {
              agent: "Analyst",
              color: "text-accent",
              text: "Index quotes streamed live. Spread checks and volatility regime verified.",
            },
            {
              agent: "Strategy",
              color: "text-gold",
              text: "Paper order router listening for intent executions and manual order triggers.",
            },
            {
              agent: "Risk",
              color: "text-danger",
              text: "Pre-trade risk pipeline enabled. Margin check active against demo wallet.",
            },
          ].map((item) => (
            <div
              key={item.agent}
              className="bg-surface-100 p-2 rounded border border-border"
            >
              <span className={`font-mono font-bold ${item.color} mr-1`}>
                [{item.agent}]
              </span>
              <span className="text-muted">{item.text}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function MetricsGrid({
  state,
  totalPnl,
}: {
  state: {
    positions: any[];
    orders: any[];
    funds: Record<string, any>;
    strategies: { status: string }[];
    indices: Record<string, { ltp: number; change: number; pct: number }>;
  };
  totalPnl: number;
}) {
  const avail = Number(state.funds.availableMargin || 1000000);
  const used = Number(state.funds.usedMargin || 0);
  const total = Number(state.funds.totalBalance || (avail + used));
  const utilPct = total > 0 ? (used / total) * 100 : 0;
  const realized = Number(state.funds.realizedPnl || 0);
  const unrealized = totalPnl - realized;
  const totalOrders = state.orders.length;
  const filledOrders = state.orders.filter((o) => o.status === "TRADED").length;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Card className="metric-card p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Day P&L
        </div>
        <div className={`text-xl font-bold font-mono ${pnlClass(totalPnl)}`}>
          {fmtINR(totalPnl)}
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Realized <span className={realized >= 0 ? "text-accent" : "text-danger"}>{fmtINR(realized)}</span> · Unr{" "}
          <span className={unrealized >= 0 ? "text-accent" : "text-danger"}>{fmtINR(unrealized)}</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Margin Used
        </div>
        <div className="text-xl font-bold font-mono text-white">{fmtINR(used)}</div>
        <div className="h-1 bg-border rounded mt-2">
          <div className="h-full bg-gold rounded" style={{ width: `${Math.min(100, utilPct)}%` }} />
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          {fmt(utilPct)}% · Avail: <span className="text-accent">{fmtINR(avail)}</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Open Positions
        </div>
        <div className="text-xl font-bold font-mono text-sky">{state.positions.length}</div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Status: <span className="text-sky font-semibold">Active Tracker</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Demo Wallet
        </div>
        <div className="text-xl font-bold font-mono text-gold">{fmtINR(total)}</div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Initial: <span className="text-muted">₹10,00,000</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Active Strats
        </div>
        <div className="text-xl font-bold font-mono text-white">
          {state.strategies.filter((s) => s.status !== "STOPPED").length}
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Paper Engine: <span className="text-accent">Ready</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Orders Today
        </div>
        <div className="text-xl font-bold font-mono text-white">
          {totalOrders}
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Filled <span className="text-accent">{filledOrders}</span> · Pending{" "}
          <span className="text-muted">{totalOrders - filledOrders}</span>
        </div>
      </Card>
    </div>
  );
}
