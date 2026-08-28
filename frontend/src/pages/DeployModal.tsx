import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import type { AppState } from '../store/types';

export function openDeployStrategyModal(
  openModal: (content: React.ReactNode) => void,
  closeModal: () => void,
  setState: React.Dispatch<React.SetStateAction<AppState>>,
  addSystemLog: (level: string, msg: string, src?: string) => void,
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void,
) {
  openModal(
    <div>
      <div className="text-sm font-bold text-white mb-3">Deploy Strategy — Sidekiq StrategyDeployWorker</div>
      <div className="space-y-3">
        <div>
          <label className="text-[9px] font-mono text-muted uppercase block mb-1">Strategy Name</label>
          <Input id="newStratName" defaultValue="NIFTY Short Straddle" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Symbol</label>
            <Select id="newStratSymbol" className="w-full"><option>NIFTY</option><option>BANKNIFTY</option><option>FINNIFTY</option></Select>
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Strategy Type</label>
            <Select id="newStratType" className="w-full"><option>STRADDLE</option><option>STRANGLE</option><option>IRON_CONDOR</option><option>PUT_SPREAD</option></Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Lots</label>
            <Input id="newStratLots" type="number" defaultValue={2} />
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Expiry</label>
            <Select className="w-full"><option>Weekly (Current)</option><option>Monthly</option></Select>
          </div>
        </div>
      </div>
      <div className="flex gap-2 justify-end mt-4">
        <Button variant="ghost" onClick={closeModal}>Cancel</Button>
        <Button onClick={() => {
          const name = (document.getElementById('newStratName') as HTMLInputElement)?.value || 'New Strategy';
          const sym = (document.getElementById('newStratSymbol') as HTMLSelectElement)?.value || 'NIFTY';
          const type = (document.getElementById('newStratType') as HTMLSelectElement)?.value || 'STRADDLE';
          const lots = parseInt((document.getElementById('newStratLots') as HTMLInputElement)?.value || '2');
          closeModal();
          showToast('StrategyDeployWorker enqueued to Sidekiq', 'success');
          addSystemLog('TRADE', `StrategyDeployWorker: ${name} (${sym} ${type}) initiated`, 'sidekiq');
          setState(prev => ({
            ...prev,
            strategies: [...prev.strategies, {
              id: `s00${prev.strategies.length + 1}`,
              name, symbol: sym, type, status: 'RUNNING' as const,
              pnl: 0, lots, entryTime: new Date().toLocaleTimeString('en-GB', { hour12: false }),
              legs: [
                { instrument: `${sym}24JAN24250CE`, side: 'SELL' as const, qty: lots * 25, bAvg: 0, sAvg: 195, ltp: 195, delta: -0.48, gamma: -0.003, theta: 8.2, vega: -12.4 },
                { instrument: `${sym}24JAN24250PE`, side: 'SELL' as const, qty: lots * 25, bAvg: 0, sAvg: 170, ltp: 170, delta: 0.45, gamma: -0.003, theta: 7.8, vega: -11.9 },
              ],
            }],
          }));
        }}>Deploy Strategy</Button>
      </div>
    </div>
  );
}
