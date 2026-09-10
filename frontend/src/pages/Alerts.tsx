import { useState, useEffect } from 'react';
import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { api } from '../services/api';
import type { Alert } from '../store/types';
import { CheckCheck, Info, AlertTriangle, XCircle, Sparkles, ExternalLink, X, Activity } from 'lucide-react';

const icons: Record<string, typeof Info> = { INFO: Info, WARN: AlertTriangle, ERROR: XCircle };
const borderColors: Record<string, string> = { INFO: 'border-sky/20', WARN: 'border-gold/20', ERROR: 'border-danger/20' };

interface ModalProps {
  alert: Alert;
  runId: string | null;
  onClose: () => void;
  onMarkRead: (id: number) => void;
}

function AlertDiagnosisModal({ alert, runId, onClose, onMarkRead }: ModalProps) {
  const { state, setState, showToast } = useApp();
  const events = runId ? state.telemetryEvents.filter((e) => e.runId === runId) : [];
  const answerEv = events.find((e) => e.type === 'OBSERVE' && e.summary?.startsWith('Answer:'));
  const isRunning = !answerEv && events.length < 5;

  const remediationMatch = (answerEv?.summary || '').match(/\[REMEDIATION: STOP_STRATEGIES ids=([a-zA-Z0-9_,]+) count=(\d+)\]/);
  const remediationIds = remediationMatch ? remediationMatch[1].split(',') : [];
  const remediationCount = remediationMatch ? Number(remediationMatch[2]) : 0;
  const [remediationApplying, setRemediationApplying] = useState(false);
  const [remediationApplied, setRemediationApplied] = useState(false);

  const handleApplyRemediation = async () => {
    setRemediationApplying(true);
    try {
      for (const id of remediationIds) {
        await api.updateStrategyStatus(id, 'STOPPED');
      }
      showToast(`Stopped ${remediationIds.length} inactive strategy(ies). Concurrency reduced.`, 'success');
      setRemediationApplied(true);
      const strats = await api.strategies().catch(() => []);
      setState((prev) => ({ ...prev, strategies: strats }));
    } catch (err: any) {
      showToast(`Remediation failed: ${err.message}`, 'error');
    } finally {
      setRemediationApplying(false);
    }
  };

  const navigateToConsole = () => {
    onClose();
    location.hash = 'agent-console';
  };

  const cleanAnswer = (answerEv?.summary || '')
    .replace(/^Answer:\s*/, '')
    .replace(/\[REMEDIATION: STOP_STRATEGIES ids=[^\]]+\]/, '')
    .trim();

  return (
    <div className="fixed inset-0 bg-black/75 z-[9000] flex items-center justify-center backdrop-blur-sm p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-surface-100 border border-border rounded-xl p-5 max-w-[620px] w-full max-h-[85vh] flex flex-col slide-in shadow-2xl relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-muted hover:text-white transition-colors">
          <X size={16} />
        </button>

        <div className="flex items-center gap-2 mb-3">
          <div className="w-6 h-6 rounded bg-purple/10 border border-purple/20 flex items-center justify-center">
            <Sparkles size={13} className="text-purple" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">AI Alert Triage & Remediation</h3>
            <span className="text-[10px] font-mono text-muted">MULTI-AGENT REACT DIAGNOSTIC RUN</span>
          </div>
        </div>

        <div className="bg-surface-50 border border-border/70 rounded-lg p-3 mb-3 text-xs">
          <div className="flex items-center justify-between text-[10px] font-mono text-muted mb-1">
            <span>SOURCE: {alert.source || 'SYSTEM'} · {alert.time}</span>
            <span className={`px-1.5 py-0.2 rounded font-bold ${alert.level === 'ERROR' ? 'text-danger' : alert.level === 'WARN' ? 'text-gold' : 'text-sky'}`}>
              {alert.level}
            </span>
          </div>
          <div className="text-white font-medium">{alert.msg}</div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[140px] max-h-[260px] border border-border/40 rounded-lg p-3 bg-bg/50">
          <div className="text-[10px] font-mono text-muted uppercase tracking-wider mb-1 flex items-center justify-between">
            <span>Diagnostic Execution Steps</span>
            {isRunning && <span className="flex items-center gap-1 text-purple"><Activity size={10} className="animate-spin" /> Analyzing live state...</span>}
          </div>

          {events.length === 0 && (
            <div className="text-xs text-muted text-center py-6">Connecting to backend agent orchestrator...</div>
          )}

          {events.map((ev) => (
            <div key={ev.id} className="text-[11px] font-mono bg-surface-100/80 rounded p-2 border border-border/40 space-y-1">
              <div className="flex items-center justify-between text-[9px] text-muted">
                <span className="text-purple font-semibold uppercase">{ev.agent} Agent [{ev.type}]</span>
                <span>{ev.time}</span>
              </div>
              <div className="text-white/90 whitespace-pre-wrap">{ev.summary}</div>
            </div>
          ))}
        </div>

        {answerEv && (
          <div className="mt-3 p-3 bg-accent/10 border border-accent/30 rounded-lg text-xs">
            <div className="text-[10px] font-mono font-bold text-accent uppercase mb-1">Agent Diagnosis & Resolution</div>
            <div className="text-white whitespace-pre-wrap text-[11.5px] leading-relaxed">{cleanAnswer}</div>
          </div>
        )}

        {remediationIds.length > 0 && !remediationApplied && (
          <div className="mt-2.5 p-2.5 bg-purple/10 border border-purple/30 rounded-lg flex items-center justify-between gap-2">
            <span className="text-[11px] text-purple-200">
              ⚡ Actionable Remediation: {remediationCount} idle strategy(ies) can be stopped to free concurrency.
            </span>
            <Button
              variant="primary"
              disabled={remediationApplying}
              onClick={handleApplyRemediation}
              className="text-xs px-2.5 py-1 shrink-0 bg-accent text-bg hover:bg-accent-bright"
            >
              <Sparkles size={12} />
              {remediationApplying ? 'Stopping...' : `Stop ${remediationCount} Idle Strategies`}
            </Button>
          </div>
        )}

        {remediationApplied && (
          <div className="mt-2.5 p-2.5 bg-accent/10 border border-accent/30 rounded-lg text-xs text-accent flex items-center gap-1.5">
            <CheckCheck size={14} /> Remediation applied: Inactive strategies stopped. Concurrency breaker cleared.
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-border">
          <Button variant="ghost" onClick={navigateToConsole} className="text-xs px-3 py-1 flex items-center gap-1.5">
            <ExternalLink size={12} /> Open in Agent Console
          </Button>
          <div className="flex items-center gap-2">
            {!alert.read && (
              <Button variant="ghost" onClick={() => { onMarkRead(alert.id); onClose(); }} className="text-xs px-3 py-1">
                Mark as Read
              </Button>
            )}
            <Button variant="primary" onClick={onClose} className="text-xs px-3 py-1">Close</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Alerts() {
  const { state, setState, showToast } = useApp();
  const [activeAlert, setActiveAlert] = useState<Alert | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  useEffect(() => {
    api.alerts(100).then((alerts) => {
      if (Array.isArray(alerts)) {
        setState((prev) => ({ ...prev, alerts: alerts.map((a: any) => ({ id: a.id, time: a.time, level: a.level, msg: a.msg, source: a.source, read: a.read ?? false })) }));
      }
    }).catch(() => { /* keep whatever is already in state */ });
  }, [setState]);

  const markAllRead = () => {
    setState((prev) => ({ ...prev, alerts: prev.alerts.map((a) => ({ ...a, read: true })) }));
    showToast('All alerts marked as read', 'success');
  };

  const markSingleRead = (id: number) => {
    setState((prev) => ({ ...prev, alerts: prev.alerts.map((a) => (a.id === id ? { ...a, read: true } : a)) }));
  };

  const handleFixWithAgent = async (alert: Alert) => {
    setActiveAlert(alert);
    setRunId(null);
    try {
      const obj = `Diagnose and remediate alert [${alert.level}] (${alert.source || 'system'}): ${alert.msg}`;
      const res = await api.runAgent(obj);
      setRunId(res.runId);
      showToast(`Agent diagnostic dispatched (${res.runId})`, 'success');
    } catch (err: any) {
      showToast(`Agent diagnostic failed: ${err.message}`, 'error');
    }
  };

  return (
    <div className="space-y-4">
      {activeAlert && (
        <AlertDiagnosisModal
          alert={activeAlert}
          runId={runId}
          onClose={() => setActiveAlert(null)}
          onMarkRead={markSingleRead}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">ActiveSupport::Notifications & Risk Alerts</div>
          <div className="text-xs text-muted mt-0.5">Real-time system, execution, and risk notifications</div>
        </div>
        <Button variant="ghost" onClick={markAllRead}><CheckCheck size={12} className="mr-1" /> Mark All as Read</Button>
      </div>

      {state.alerts.length === 0 && (
        <Card className="p-8 text-center text-muted text-xs">No alerts yet.</Card>
      )}

      <div className="space-y-2.5">
        {state.alerts.map((a) => {
          const Icon = icons[a.level] || Info;
          return (
            <Card key={a.id} className={`p-3.5 ${borderColors[a.level]} ${a.read ? 'opacity-50' : ''} slide-in`}>
              <div className="flex items-start gap-3">
                <Icon size={14} className="mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-white break-words">{a.msg}</div>
                  <div className="text-[9.5px] font-mono text-muted mt-1">{a.time} · Level: {a.level} · Source: {a.source || 'system'}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    className="text-[11px] h-7 px-2 border-purple/30 text-purple hover:bg-purple/10 flex items-center gap-1.5"
                    onClick={() => handleFixWithAgent(a)}
                  >
                    <Sparkles size={11} className="text-purple" />
                    Fix with Agent
                  </Button>
                  {!a.read && <div className="w-2 h-2 rounded-full bg-accent mt-0.5 shrink-0" />}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
