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

export function Header({ pageTitle, pageSubtitle, onKillSwitch }: HeaderProps) {
  const { state, connected } = useApp();
  const defaultIdx = {
    ltp: 0,
    change: 0,
    pct: 0,
    high: 0,
    low: 0,
    open: 0,
    prevClose: 0,
  };
  const indices = state.indices || {};
  const nifty = indices.NIFTY || defaultIdx;
  const bnf = indices.BANKNIFTY || defaultIdx;
  const vix = indices.INDIAVIX || defaultIdx;

  return (
    <header className="h-14 min-h-[56px] bg-surface-100 border-b border-border flex items-center justify-between px-5 z-20">
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
          <div className="flex items-center gap-1.5">
            <span className="text-muted text-[10px]">NIFTY</span>
            <span className="text-white font-semibold">{fmt(nifty.ltp)}</span>
            <span
              className={`text-[10px] ${nifty.change >= 0 ? "text-accent" : "text-danger"}`}
            >
              {nifty.change >= 0 ? "+" : ""}
              {fmt(nifty.pct)}%
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted text-[10px]">BANKNIFTY</span>
            <span className="text-white font-semibold">{fmt(bnf.ltp)}</span>
            <span
              className={`text-[10px] ${bnf.change >= 0 ? "text-accent" : "text-danger"}`}
            >
              {bnf.change >= 0 ? "+" : ""}
              {fmt(bnf.pct)}%
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-muted text-[10px]">INDIA VIX</span>
            <span className="text-gold font-semibold">{fmt(vix.ltp)}</span>
            <span className="text-accent text-[10px]">
              {vix.change >= 0 ? "+" : ""}
              {fmt(vix.pct)}%
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3 border-l border-border pl-4">
          <div className="font-mono text-xs text-muted">
            {new Date().toLocaleTimeString("en-GB", {
              hour12: false,
              timeZone: "Asia/Kolkata",
            })}
          </div>
          <div className="flex items-center gap-1.5">
            <StatusDot
              status={connected ? "live" : "error"}
              pulse={connected}
            />
            <span
              className={`text-[11px] font-mono font-semibold ${connected ? "text-accent" : "text-danger"}`}
            >
              {state.killed
                ? "SYSTEM HALTED"
                : connected
                  ? "MARKET OPEN"
                  : "OFFLINE"}
            </span>
          </div>
        </div>
        <Button
          variant="danger"
          className="text-[11px] px-3.5 py-1.5"
          onClick={onKillSwitch}
        >
          <Power size={12} /> KILL SWITCH
        </Button>
      </div>
    </header>
  );
}
