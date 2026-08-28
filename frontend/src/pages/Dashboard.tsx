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
  const totalPnl = state.strategies.reduce(
    (s, x) => s + (x.status !== "STOPPED" ? x.pnl : 0),
    0,
  );
  const canvasRef = usePnlChart(state.pnlHistory);

  return (
    <div className="dashboard-shell space-y-5">
      <div className="dashboard-intro">
        <div>
          <div className="text-[10px] font-mono text-accent uppercase tracking-[0.18em] font-semibold">
            Trading desk / session overview
          </div>
          <h2>Good afternoon, the book is working.</h2>
          <p>
            Live exposure, execution quality, and strategy health in one view.
          </p>
        </div>
        <div className="session-chip">
          <span className="status-dot live pulse-live" /> NSE session active
        </div>
      </div>
      <MetricsGrid state={state} totalPnl={totalPnl} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">
                Intraday P&L Performance Curve
              </span>
              <span className="text-[9px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                REALTIME
              </span>
            </div>
          </div>
          <canvas ref={canvasRef} height={190} className="w-full" />
        </Card>
        <Card className="p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">
                Active Strategies
              </span>
              <button
                className="text-[10px] font-mono text-accent hover:underline"
                onClick={() => onNavigate("strategies")}
              >
                View All →
              </button>
            </div>
            <div className="space-y-2.5">
              {state.strategies
                .filter((s) => s.status !== "STOPPED")
                .map((s) => (
                  <div
                    key={s.id}
                    className="p-2.5 rounded-lg bg-surface-50 border border-border hover:border-[#2a3d5e] transition-all cursor-pointer"
                    onClick={() => onNavigate("strategies")}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-semibold text-white">
                        {s.name}
                      </span>
                      <StratBadge status={s.status} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[9.5px] font-mono text-muted">
                        {s.symbol} · {s.type} · {s.lots}L
                      </span>
                      <span
                        className={`text-xs font-mono font-bold ${pnlClass(s.pnl)}`}
                      >
                        {fmtINR(s.pnl)}
                      </span>
                    </div>
                  </div>
                ))}
            </div>
          </div>
          <Button className="w-full mt-3" onClick={onDeploy}>
            <Plus size={14} /> Deploy New Strategy
          </Button>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest mb-3 font-semibold">
            Market Spot Indices
          </div>
          <div className="space-y-2.5">
            {Object.entries(state.indices).map(([sym, d]) => (
              <div
                key={sym}
                className="flex items-center justify-between p-2 rounded bg-surface-50 border border-border"
              >
                <div>
                  <div className="text-xs font-semibold text-white">{sym}</div>
                  <div className="text-[9px] font-mono text-muted">SPOT</div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-mono font-bold text-white">
                    {fmt(d.ltp)}
                  </div>
                  <div
                    className={`${d.change >= 0 ? "text-accent" : "text-danger"} text-[10px] font-mono`}
                  >
                    {d.change >= 0 ? "▲" : "▼"}
                    {fmt(Math.abs(d.change))} ({fmt(Math.abs(d.pct))}%)
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="col-span-2 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">
              Recent Order Fills (Audit Stream)
            </span>
            <button
              className="text-[10px] font-mono text-accent hover:underline"
              onClick={() => onNavigate("orders")}
            >
              Full Order Book →
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {[
                    "Time",
                    "Instrument",
                    "Side",
                    "Qty",
                    "Price",
                    "Strategy / Corr ID",
                    "Status",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left px-2.5 py-2 text-muted font-medium border-b border-border text-[9.5px] uppercase tracking-[0.5px]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.recentFills.map((f, i) => (
                  <tr key={i} className="hover:bg-surface-200/50">
                    <td className="px-2.5 py-[7px] border-b border-border/60 text-muted">
                      {f.time}
                    </td>
                    <td className="px-2.5 py-[7px] border-b border-border/60 text-white">
                      {f.instrument}
                    </td>
                    <td
                      className={`px-2.5 py-[7px] border-b border-border/60 font-semibold ${sideClass(f.side)}`}
                    >
                      {f.side}
                    </td>
                    <td className="px-2.5 py-[7px] border-b border-border/60 text-white">
                      {f.qty}
                    </td>
                    <td className="px-2.5 py-[7px] border-b border-border/60 text-white">
                      {fmt(f.price)}
                    </td>
                    <td className="px-2.5 py-[7px] border-b border-border/60 text-sky text-[9.5px]">
                      {f.strategy} ({f.corr.substring(0, 10)})
                    </td>
                    <td className="px-2.5 py-[7px] border-b border-border/60">
                      <Badge status={f.status} />
                    </td>
                  </tr>
                ))}
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
              text: "Target theta decay rate: +845 INR/day on Iron Condor. Next rebalance checkpoint at 14:00.",
            },
            {
              agent: "Analyst",
              color: "text-accent",
              text: "PCR 1.12 with spot at 24,248 > max pain (24,200). Put writers maintaining support at 24,100.",
            },
            {
              agent: "Strategy",
              color: "text-gold",
              text: "IVR 42.3 remains in sell-friendly regime. Bull Put Spread & Iron Condor optimal.",
            },
            {
              agent: "Risk",
              color: "text-danger",
              text: "Short gamma (-2.14) active in straddle. Auto-hedge triggers if |spot - ATM| > 200 pts.",
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
    strategies: { status: string }[];
    indices: Record<string, { ltp: number; change: number; pct: number }>;
  };
  totalPnl: number;
}) {
  const totalTrades = 47;
  const wins = 31;
  const losses = 16;
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
          Realized <span className="text-accent">+18.2K</span> · Unr{" "}
          <span className="text-accent">+6.6K</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Margin Used
        </div>
        <div className="text-xl font-bold font-mono text-white">2,45,000</div>
        <div className="h-1 bg-border rounded mt-2">
          <div className="h-full bg-gold rounded" style={{ width: "49%" }} />
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          49% · Avail: <span className="text-accent">2.55L</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Portfolio Delta
        </div>
        <div className="text-xl font-bold font-mono text-sky">+0.03</div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Status: <span className="text-sky font-semibold">Delta-Neutral</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Max Drawdown
        </div>
        <div className="text-xl font-bold font-mono text-gold">-12,400</div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Limit: <span className="text-muted">50,000 (24.8%)</span>
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
          Sidekiq Enqueued: <span className="text-accent">12 jobs</span>
        </div>
      </Card>
      <Card className="p-3.5">
        <div className="text-[9px] font-mono text-muted uppercase tracking-widest mb-1 font-semibold">
          Trades Today
        </div>
        <div className="text-xl font-bold font-mono text-white">
          {totalTrades}
        </div>
        <div className="text-[10px] font-mono text-muted mt-1">
          Win <span className="text-accent">{wins}</span> · Loss{" "}
          <span className="text-danger">{losses}</span>
        </div>
      </Card>
    </div>
  );
}
