import { useEffect, useRef } from 'react';
import { Terminal, Cpu, Sparkles, AlertTriangle } from 'lucide-react';
import { useApp } from '../../store/AppContext';

/**
 * Live view of what the research engine is actually doing during a refresh.
 *
 * Reads the telemetry stream the backend already publishes (no new plumbing),
 * filtered to research steps. Each line shows which engine produced it, so an
 * LLM answer is never mistaken for a deterministic one — the debate judge
 * falls back to canned text whenever the model fails to answer.
 */

const ENGINE_STYLE: Record<string, { label: string; cls: string; Icon: typeof Cpu }> = {
  DETERMINISTIC: { label: 'RULES', cls: 'text-sky-400 border-sky-500/30 bg-sky-500/10', Icon: Cpu },
  AI: { label: 'AI', cls: 'text-violet-400 border-violet-500/30 bg-violet-500/10', Icon: Sparkles },
  AI_FALLBACK: { label: 'AI→RULES', cls: 'text-amber-400 border-amber-500/30 bg-amber-500/10', Icon: AlertTriangle },
};

interface Props {
  running?: boolean;
  /** Lines to keep on screen. */
  limit?: number;
}

export function ResearchActivityLog({ running = false, limit = 40 }: Props) {
  const { state } = useApp();
  const endRef = useRef<HTMLDivElement>(null);

  const events = (state.telemetryEvents || [])
    .filter((e) => typeof e.summary === 'string' && e.summary.includes('[RESEARCH:'))
    .slice(-limit);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [events.length]);

  return (
    <div className="bg-surface-100 border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Terminal size={13} className="text-accent" />
          <span className="text-xs font-semibold text-white">Background Activity</span>
          {running && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-accent">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              running
            </span>
          )}
        </div>
        <span className="text-[10px] font-mono text-muted">{events.length} steps</span>
      </div>

      <div className="max-h-56 overflow-y-auto px-3 py-2 space-y-1">
        {events.length === 0 ? (
          <p className="text-[11px] text-muted font-mono py-3 text-center">
            No research activity yet — run a screen or analysis to see each step here.
          </p>
        ) : (
          events.map((e) => {
            const style = ENGINE_STYLE[e.engine || 'DETERMINISTIC'] || ENGINE_STYLE.DETERMINISTIC;
            const { Icon } = style;
            // Strip the "[RESEARCH:STEP] " prefix; show the step as its own chip.
            const match = /^\[RESEARCH:([A-Z_]+)\]\s*(.*)$/.exec(e.summary || '');
            const step = match?.[1] || 'STEP';
            const text = match?.[2] || e.summary;
            // A failed or degraded run must not read like a normal step.
            const isError = step === 'ERROR';
            const isWarning = !isError && /^WARNING:/.test(text || '');
            return (
              <div
                key={e.id}
                className={`flex items-start gap-2 text-[11px] font-mono leading-relaxed ${
                  isError ? 'text-rose-300' : isWarning ? 'text-amber-300' : ''
                }`}
              >
                <span className="text-muted shrink-0">{e.time}</span>
                <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 rounded border text-[9px] font-bold ${style.cls}`}>
                  <Icon size={9} />
                  {style.label}
                </span>
                <span className={`shrink-0 text-[9px] font-bold uppercase w-16 ${isError ? 'text-rose-400' : 'text-zinc-500'}`}>{step}</span>
                <span className={`break-words ${isError ? 'text-rose-300' : isWarning ? 'text-amber-300' : 'text-zinc-300'}`}>{text}</span>
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
