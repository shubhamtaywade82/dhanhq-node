import { ShieldCheck, TrendingUp, AlertTriangle, Scale, Layers } from 'lucide-react';

export function ResearchTabs({ activeTab, onSelect, count }: any) {
  const tabs = [
    { id: 'verdict', label: 'Executive Stance', icon: <ShieldCheck size={13} /> },
    { id: 'valuation', label: '3-Stage DCF', icon: <Scale size={13} /> },
    { id: 'debate', label: 'Bull vs Bear Debate', icon: <AlertTriangle size={13} /> },
    { id: 'signal', label: 'Trade Setup Signal', icon: <TrendingUp size={13} /> },
    { id: 'evidence', label: `Evidence Ledger (${count})`, icon: <Layers size={13} /> },
  ];
  return (
    <div className="flex items-center gap-1 border-b border-border pb-1 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium cursor-pointer whitespace-nowrap ${activeTab === t.id ? 'bg-surface-200 text-white border border-border font-semibold' : 'text-muted hover:text-white'}`}
        >
          {t.icon}<span>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

export function VerdictTab({ run }: any) {
  const v = run.verdict;
  const moat = run.businessMoat?.moat;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-2">
        <div className="text-xs font-mono uppercase text-muted font-semibold">Growth Catalysts & Thesis Invalidation</div>
        <div className="space-y-1 text-xs text-zinc-300">
          {(v?.keyCatalysts || []).map((c: string, i: number) => <div key={i} className="flex gap-2"><span className="text-emerald-400">✓</span><span>{c}</span></div>)}
          {(v?.thesisBreakers || []).map((t: string, i: number) => <div key={i} className="flex gap-2"><span className="text-rose-400">✗</span><span>{t}</span></div>)}
        </div>
      </div>
      <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-2">
        <div className="text-xs font-mono uppercase text-muted font-semibold">7-Factor Moat Profile ({moat?.aggregateScore ?? '--'}/100)</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[['Brand', moat?.brandScore], ['Pricing Power', moat?.pricingPowerScore], ['Switching Costs', moat?.switchingCostScore], ['Cost Advantage', moat?.costAdvantageScore], ['Tech Proprietary', moat?.techProprietaryScore], ['Network Effect', moat?.networkEffectScore]].map(([l, val]: any) => (
            <div key={l} className="p-2 bg-surface-200/60 rounded border border-border/40"><div className="text-[10px] text-muted">{l}</div><div className="text-xs font-bold font-mono text-white mt-0.5">{val ?? '--'}/100</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ValuationTab({ fin }: any) {
  if (!fin) return null;
  const d = fin.dcf;
  return (
    <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-3">
      <div className="text-xs font-mono uppercase text-muted font-semibold">3-Stage DCF Valuation Bands</div>
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="p-2.5 bg-surface-200 rounded border border-rose-500/20"><div className="text-[10px] text-muted uppercase">Bear</div><div className="text-sm font-bold font-mono text-rose-400">₹{d.bearFairValue}</div></div>
        <div className="p-2.5 bg-surface-200 rounded border border-accent/30"><div className="text-[10px] text-muted uppercase">Base Fair Value</div><div className="text-sm font-bold font-mono text-accent">₹{d.baseFairValue}</div></div>
        <div className="p-2.5 bg-surface-200 rounded border border-emerald-500/20"><div className="text-[10px] text-muted uppercase">Bull</div><div className="text-sm font-bold font-mono text-emerald-400">₹{d.bullFairValue}</div></div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        {[['Margin of Safety', `${d.marginOfSafetyPct}%`], ['CFO / PAT', `${fin.cfoVsPatRatio}x`], ['ROIC %', `${fin.roicPct}%`], ['Debt / Equity', fin.debtToEquity]].map(([l, val]: any) => (
          <div key={l} className="p-2 bg-surface-200 rounded border border-border/50"><div className="text-[10px] text-muted">{l}</div><div className="font-mono font-bold text-white mt-0.5">{val}</div></div>
        ))}
      </div>
    </div>
  );
}

export function DebateTab({ debate }: any) {
  if (!debate) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="p-4 bg-surface-100 border border-emerald-500/20 rounded-lg space-y-2">
        <div className="text-xs font-mono uppercase text-emerald-400 font-semibold">Bull Thesis</div>
        <div className="space-y-1 text-xs text-zinc-300">{(debate.bullThesis || []).map((b: string, i: number) => <div key={i} className="flex gap-1.5"><span className="text-emerald-400">▲</span><span>{b}</span></div>)}</div>
      </div>
      <div className="p-4 bg-surface-100 border border-rose-500/20 rounded-lg space-y-2">
        <div className="text-xs font-mono uppercase text-rose-400 font-semibold">Bear Red-Team</div>
        <div className="space-y-1 text-xs text-zinc-300">{(debate.bearThesis || []).map((r: string, i: number) => <div key={i} className="flex gap-1.5"><span className="text-rose-400">▼</span><span>{r}</span></div>)}</div>
      </div>
    </div>
  );
}

export function SignalTab({ signal, options }: any) {
  if (!signal) return null;
  return (
    <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-3">
      <div className="flex items-center justify-between">
        <div><div className="text-[10px] font-mono text-muted uppercase">Institutional Trade Setup</div><div className="text-sm font-bold text-white font-mono">{signal.bias} Bias ({signal.conviction}/100)</div></div>
        <div className="text-right"><div className="text-[10px] font-mono text-muted uppercase">Horizon</div><div className="text-xs font-bold font-mono text-accent">{signal.horizon}</div></div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        {[['Options PCR OI', options?.pcrOi ?? '--'], ['Max Pain Strike', `₹${options?.maxPainStrike ?? '--'}`], ['Call Wall', `₹${options?.callOiWall ?? '--'}`], ['Put Wall', `₹${options?.putOiWall ?? '--'}`]].map(([l, val]: any) => (
          <div key={l} className="p-2 bg-surface-200 rounded border border-border/50"><div className="text-[10px] text-muted">{l}</div><div className="font-mono font-bold text-white mt-0.5">{val}</div></div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {(signal.suggestedStructures || []).map((s: string) => <span key={s} className="px-2.5 py-1 rounded text-xs font-mono font-semibold bg-accent/15 text-accent border border-accent/30">{s}</span>)}
      </div>
    </div>
  );
}

export function EvidenceTab({ evidence }: any) {
  return (
    <div className="p-4 bg-surface-100 border border-border rounded-lg space-y-2">
      <div className="text-xs font-mono uppercase text-muted font-semibold">Auditable Fact & Claim Ledger ({evidence.length})</div>
      <div className="overflow-x-auto max-h-[350px]">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border/60 text-muted font-mono text-[10px] uppercase">
              <th className="py-1.5 px-2">ID</th><th className="py-1.5 px-2">Category</th><th className="py-1.5 px-3">Factual Claim</th><th className="py-1.5 px-2">Source</th><th className="py-1.5 px-2">Conf</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {evidence.map((e: any) => (
              <tr key={e.id} className="hover:bg-surface-200/40">
                <td className="py-1.5 px-2 font-mono text-accent text-[11px]">{e.id}</td>
                <td className="py-1.5 px-2 uppercase font-mono text-[10px] text-zinc-400">{e.category}</td>
                <td className="py-1.5 px-3 text-zinc-200">{e.claim}</td>
                <td className="py-1.5 px-2 font-mono text-zinc-400 text-[10px]">{e.source}</td>
                <td className="py-1.5 px-2 font-mono text-zinc-300 text-[11px]">{Math.round((e.confidence || 0) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
