import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';

const TOOLS_CATALOG = [
  { name: 'dhan.get_option_chain', desc: 'POST /v2/optionchain — Real-time chain with Greeks, IV, OI', type: 'dhan', params: ['UnderlyingScrip', 'Expiry'] },
  { name: 'dhan.get_ltp', desc: 'POST /v2/marketfeed/ltp — Last traded prices', type: 'dhan', params: ['NSE_FNO[]'] },
  { name: 'dhan.get_positions', desc: 'GET /v2/positions — All open positions', type: 'dhan', params: [] },
  { name: 'dhan.get_orders', desc: 'GET /v2/orders — Order book with correlationId', type: 'dhan', params: [] },
  { name: 'dhan.place_order', desc: 'POST /v2/orders — Place order with idempotency', type: 'dhan', params: ['order_params', 'correlationId'] },
  { name: 'dhan.calc_multi_margin', desc: 'POST /v2/margincalculator/multi — Combined margin', type: 'dhan', params: ['scripList[]'] },
  { name: 'dhan.get_fund_limits', desc: 'GET /v2/fundlimit — Available cash & margin', type: 'dhan', params: [] },
  { name: 'ollama.analyze_sentiment', desc: 'LLM market context analysis → Sentiment score', type: 'ollama', params: ['context'] },
  { name: 'ollama.generate_strategy', desc: 'LLM strategy recommendation', type: 'ollama', params: ['market_analysis'] },
  { name: 'ollama.evaluate_risk', desc: 'LLM portfolio risk assessment', type: 'ollama', params: ['positions', 'greeks'] },
];

const tagClasses: Record<string, string> = {
  dhan: 'bg-cyan-500/10 text-cyan-400',
  ollama: 'bg-purple/10 text-purple',
  risk: 'bg-danger/10 text-danger',
};

export function AgentToolsMemory() {
  const { state } = useApp();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-border pb-2">
          <div>
            <div className="text-xs font-bold text-white">Tool Registry (Pillar 2: The Hands)</div>
            <div className="text-[9.5px] font-mono text-muted">DhanHQ SDK, Ollama LLM, and Risk Engine tools</div>
          </div>
          <span className="inline-flex items-center px-1.75 py-0.5 rounded text-[9.5px] font-mono font-semibold bg-accent/12 text-accent">{TOOLS_CATALOG.length} Tools</span>
        </div>
        <div className="space-y-2.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
          {TOOLS_CATALOG.map((t) => (
            <div key={t.name} className="p-2.5 rounded bg-surface-50 border border-border">
              <div className="flex items-center gap-2 mb-1">
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-weight-600 font-mono ${tagClasses[t.type]}`}>{t.type.toUpperCase()}</span>
                <span className="text-xs font-mono font-bold text-white">{t.name}</span>
              </div>
              <div className="text-[10px] text-muted">{t.desc}</div>
              {t.params.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {t.params.map((p) => (
                    <span key={p} className="text-[8.5px] font-mono bg-bg text-muted px-1.5 py-0.5 rounded border border-border">{p}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="p-4 space-y-3">
          <div className="text-xs font-bold text-white border-b border-border pb-2">Agent Memory System (Pillar 3: Memory)</div>
          <div className="grid grid-cols-3 gap-2.5">
            <div className="bg-surface-50 p-2.5 rounded border border-border">
              <div className="text-[8.5px] font-mono text-sky uppercase mb-1 font-semibold">Working Memory</div>
              <div className="text-[9px] text-muted">Current loop context (~8K tokens).</div>
              <div className="mt-2 text-[9px] font-mono text-sky">[Idle]</div>
            </div>
            <div className="bg-surface-50 p-2.5 rounded border border-border">
              <div className="text-[8.5px] font-mono text-gold uppercase mb-1 font-semibold">Short-Term Memory</div>
              <div className="text-[9px] text-muted">Session context (~32K).</div>
              <div className="mt-2 text-[9px] font-mono text-gold">3 items</div>
            </div>
            <div className="bg-surface-50 p-2.5 rounded border border-border">
              <div className="text-[8.5px] font-mono text-purple uppercase mb-1 font-semibold">Long-Term Memory</div>
              <div className="text-[9px] text-muted">Vector embeddings + KV store.</div>
              <div className="mt-2 text-[9px] font-mono text-purple">4 indexed</div>
            </div>
          </div>
        </Card>

        <Card className="p-4 space-y-2.5">
          <div className="text-[9.5px] font-mono text-muted uppercase tracking-widest font-semibold">Historical Vector Memory Recall</div>
          <div className="space-y-2">
            {state.ltmMemories.map((m, i) => (
              <div key={i} className="p-2.5 rounded bg-surface-50 border border-border text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9.5px] font-mono text-muted">{m.date}</span>
                  <span className="text-[9px] font-mono text-purple bg-purple/10 px-1.5 py-0.5 rounded">Sim: {m.sim}</span>
                </div>
                <div className="text-white/90 text-[11px]">{m.note}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
