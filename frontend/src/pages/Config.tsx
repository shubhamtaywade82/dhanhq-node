import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Plug, Shield, Brain, Code } from 'lucide-react';

export function Config() {
  const { showToast, addSystemLog } = useApp();

  return (
    <div className="space-y-4">
      <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">System Configuration & Governance</div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Plug size={14} className="text-accent" /> Broker & DhanHQ Credentials</div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Dhan Client ID</label>
            <Input type="password" defaultValue="••••••••1002" />
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Access Token</label>
            <Input type="password" defaultValue="••••••••••••••••••••••••" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">Broker Engine</label>
              <Select className="w-full"><option>DhanHQ (Primary)</option></Select>
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">Static IP Binding</label>
              <Input defaultValue="103.14.120.45" readOnly />
            </div>
          </div>
          <Button onClick={() => { showToast('Broker connection PASSED — 18ms', 'success'); addSystemLog('INFO', 'Broker connection verified', 'broker'); }}>Test Broker Connection</Button>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Shield size={14} className="text-gold" /> Risk Engine Limits</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">daily_loss_limit (INR)</label>
              <Input type="number" defaultValue={50000} />
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">max_margin_pct (%)</label>
              <Input type="number" defaultValue={70} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">per_strategy_limit (INR)</label>
              <Input type="number" defaultValue={200000} />
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">max_open_lots</label>
              <Input type="number" defaultValue={50} />
            </div>
          </div>
          <Button onClick={() => showToast('Risk parameters saved', 'success')}>Save Risk Config</Button>
        </Card>

        <Card className="p-4 space-y-3">
          <div className="text-xs font-semibold text-white flex items-center gap-2"><Brain size={14} className="text-purple" /> Ollama AI & Agentic Guardrails</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">Ollama Base URL</label>
              <Input defaultValue="http://localhost:11434" />
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">Model</label>
              <Select className="w-full"><option>llama3.1:8b</option><option>qwen2.5:14b</option></Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">Max Execution Steps</label>
              <Input type="number" defaultValue={12} />
            </div>
            <div>
              <label className="text-[9px] font-mono text-muted uppercase block mb-1">Temperature</label>
              <Input type="number" defaultValue={0.1} step={0.05} />
            </div>
          </div>
          <Button onClick={() => showToast('Ollama parameters synchronized', 'success')}>Save Agent Config</Button>
        </Card>

        <Card className="p-4 space-y-2.5 font-mono text-xs">
          <div className="text-xs font-semibold text-white mb-2 flex items-center gap-2"><Code size={14} className="text-sky" /> Stack Version Metadata</div>
          <div className="flex justify-between"><span className="text-muted">Rails</span><span className="text-white">8.1.3 (API)</span></div>
          <div className="flex justify-between"><span className="text-muted">Ruby</span><span className="text-white">3.3.4</span></div>
          <div className="flex justify-between"><span className="text-muted">dhanhq-sdk</span><span className="text-accent">1.4.2</span></div>
          <div className="flex justify-between"><span className="text-muted">Sidekiq</span><span className="text-white">7.2.1</span></div>
          <div className="flex justify-between"><span className="text-muted">AASM State Machine</span><span className="text-white">5.5.0</span></div>
          <div className="flex justify-between"><span className="text-muted">Ollama SDK</span><span className="text-purple">0.4.1</span></div>
          <div className="flex justify-between"><span className="text-muted">Last Deployment</span><span className="text-white">2025-01-28 08:45 IST</span></div>
        </Card>
      </div>
    </div>
  );
}
