import { useApp } from '../store/AppContext';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { CheckCheck, Info, AlertTriangle, XCircle } from 'lucide-react';

const icons: Record<string, typeof Info> = { INFO: Info, WARN: AlertTriangle, ERROR: XCircle };
const borderColors: Record<string, string> = { INFO: 'border-sky/20', WARN: 'border-gold/20', ERROR: 'border-danger/20' };

export function Alerts() {
  const { state, setState, showToast } = useApp();

  const markAllRead = () => {
    setState(prev => ({
      ...prev,
      alerts: prev.alerts.map(a => ({ ...a, read: true })),
    }));
    showToast('All alerts marked as read', 'success');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-mono text-muted uppercase tracking-widest font-semibold">ActiveSupport::Notifications & Risk Alerts</div>
          <div className="text-xs text-muted mt-0.5">Real-time system, execution, and risk notifications</div>
        </div>
        <Button variant="ghost" onClick={markAllRead}><CheckCheck size={12} className="mr-1" /> Mark All as Read</Button>
      </div>

      <div className="space-y-2.5">
        {state.alerts.map((a) => {
          const Icon = icons[a.level] || Info;
          return (
            <Card key={a.id} className={`p-3.5 ${borderColors[a.level]} ${a.read ? 'opacity-50' : ''} slide-in`}>
              <div className="flex items-start gap-3">
                <Icon size={14} className="mt-0.5 shrink-0" />
                <div className="flex-1">
                  <div className="text-xs text-white">{a.msg}</div>
                  <div className="text-[9.5px] font-mono text-muted mt-1">{a.time} · Level: {a.level}</div>
                </div>
                {!a.read && <div className="w-2 h-2 rounded-full bg-accent mt-1 shrink-0" />}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
