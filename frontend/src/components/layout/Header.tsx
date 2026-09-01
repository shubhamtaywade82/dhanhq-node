import { useState, useEffect } from "react";
import { useApp } from "../../store/AppContext";
import { fmt } from "../../utils/formatters";
import { Button } from "../ui/Button";
import { StatusDot } from "../ui/StatusDot";
import { Bolt, Power } from "lucide-react";

interface HeaderProps {
  pageTitle: string;
  pageSubtitle: string;
  onKillSwitch: () => void;
}

interface TickerData {
  ltp: number;
  change: number;
  pct: number;
}

function Ticker({ label, data, valueClass = "text-white" }: { label: string; data: TickerData | null; valueClass?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted text-[10px]">{label}</span>
      {data ? (
        <>
          <span className={`${valueClass} font-semibold`}>{fmt(data.ltp)}</span>
          <span className={`text-[10px] ${data.change >= 0 ? "text-accent" : "text-danger"}`}>
            {data.change >= 0 ? "+" : ""}
            {fmt(data.pct)}%
          </span>
        </>
      ) : (
        <span className="text-muted">—</span>
      )}
    </div>
  );
}

export function Header({ pageTitle, pageSubtitle, onKillSwitch }: HeaderProps) {
  const { state, connected } = useApp();
  const [timeStr, setTimeStr] = useState(() =>
    new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" }),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeStr(new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Kolkata" }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // No fabricated fallback quotes — an index shows "—" until a real live tick arrives.
  const indices = state.indices || {};
  const nifty = indices.NIFTY?.ltp ? indices.NIFTY : null;
  const bnf = indices.BANKNIFTY?.ltp ? indices.BANKNIFTY : null;
  const sensex = indices.SENSEX?.ltp ? indices.SENSEX : null;
  const vix = indices.INDIAVIX?.ltp ? indices.INDIAVIX : null;

  return (
    <header className="app-header h-14 min-h-[56px] bg-surface-100 border-b border-border flex items-center justify-between px-5 z-20">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
            <Bolt size={14} className="text-accent" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-wider text-white flex items-center gap-2">
              <span>AXIS NEXUS</span>
              <span className="text-[9px] font-mono bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded">
                v4.2 PROD
              </span>
            </div>
            <div className="text-[9.5px] font-mono text-muted tracking-wide">
              Options Engine & Multi-Agent Control Plane
            </div>
          </div>
        </div>
        <div className="h-6 w-px bg-border mx-2" />
        <div className="flex items-center gap-2">
          <h1 className="text-xs font-semibold text-white">{pageTitle}</h1>
          <span className="text-[9px] font-mono text-muted bg-surface-300 px-2 py-0.5 rounded border border-border">
            {pageSubtitle}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-5">
        <div className="hidden lg:flex items-center gap-4 font-mono text-xs">
          <Ticker label="NIFTY" data={nifty} />
          <Ticker label="BANKNIFTY" data={bnf} />
          <Ticker label="SENSEX" data={sensex} />
          <Ticker label="INDIA VIX" data={vix} valueClass="text-gold" />
        </div>
        <div className="flex items-center gap-3 border-l border-border pl-4">
          <div className="font-mono text-xs text-muted">{timeStr}</div>
          <div className="flex items-center gap-1.5">
            <StatusDot status={connected ? "live" : "error"} pulse={connected} />
            <span
              className={`text-[11px] font-mono font-semibold ${connected ? "text-accent" : "text-danger"}`}
            >
              {state.killed ? "SYSTEM HALTED" : connected ? "MARKET OPEN" : "OFFLINE"}
            </span>
          </div>
        </div>
        <Button variant="danger" className="text-[11px] px-3.5 py-1.5" onClick={onKillSwitch}>
          <Power size={12} /> KILL SWITCH
        </Button>
      </div>
    </header>
  );
}
