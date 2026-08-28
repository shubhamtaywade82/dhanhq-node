import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { api } from '../services/api';
import type { AppState } from '../store/types';

export function openDeployStrategyModal(
  openModal: (content: React.ReactNode) => void,
  closeModal: () => void,
  _setState: React.Dispatch<React.SetStateAction<AppState>>,
  addSystemLog: (level: string, msg: string, src?: string) => void,
  showToast: (msg: string, type?: 'success' | 'error' | 'warning') => void,
  refreshPortfolio?: () => Promise<void>,
) {
  openModal(
    <div>
      <div className="text-sm font-bold text-white mb-3">Deploy Strategy — Multi-Leg Execution</div>
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
        <Button onClick={async () => {
          const name = (document.getElementById('newStratName') as HTMLInputElement)?.value || 'New Strategy';
          const sym = (document.getElementById('newStratSymbol') as HTMLSelectElement)?.value || 'NIFTY';
          const type = (document.getElementById('newStratType') as HTMLSelectElement)?.value || 'STRADDLE';
          const lots = parseInt((document.getElementById('newStratLots') as HTMLInputElement)?.value || '2', 10);
          const lotSize = sym === 'BANKNIFTY' ? 15 : 25;
          const qty = lots * lotSize;

          closeModal();
          try {
            const legs = [
              { instrument: `${sym}24JAN${sym === 'BANKNIFTY' ? '51500' : '24500'}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 195, ltp: 195, delta: -0.5, gamma: -0.003, theta: 8.2, vega: -12.4 },
              { instrument: `${sym}24JAN${sym === 'BANKNIFTY' ? '51500' : '24500'}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 170, ltp: 170, delta: 0.5, gamma: -0.003, theta: 7.8, vega: -11.9 },
            ];
            await api.deployStrategy({ name, symbol: sym, type, lots, legs });
            if (refreshPortfolio) await refreshPortfolio();
            showToast(`Strategy ${name} deployed with ${legs.length} legs`, 'success');
            addSystemLog('TRADE', `Strategy deployed: ${name} (${sym} ${type}) with ${legs.length} legs`, 'strategy_engine');
          } catch (e: any) {
            showToast(`Failed to deploy strategy: ${e.message}`, 'error');
          }
        }}>Deploy Strategy</Button>
      </div>
    </div>,
  );
}
