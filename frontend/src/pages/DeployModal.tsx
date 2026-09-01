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
      <div className="text-sm font-bold text-white mb-3">Deploy Strategy — Multi-Leg / Buying Execution</div>
      <div className="space-y-3">
        <div>
          <label className="text-[9px] font-mono text-muted uppercase block mb-1">Strategy Name</label>
          <Input id="newStratName" defaultValue="NIFTY 15m ORB Buy" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Symbol</label>
            <Select id="newStratSymbol" className="w-full">
              <option value="NIFTY">NIFTY 50 (Lot: 65)</option>
              <option value="BANKNIFTY">BANKNIFTY (Lot: 30)</option>
              <option value="SENSEX">BSE SENSEX (Lot: 20)</option>
              <option value="FINNIFTY">FINNIFTY (Lot: 60)</option>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Strategy Engine</label>
            <Select id="newStratType" className="w-full">
              <option value="ORB_15M">🚀 15m Spot ORB (Buy ATM)</option>
              <option value="ORB_PREM_200">🎯 ₹200 ITM Premium ORB</option>
              <option value="VWAP_RSI">🌊 VWAP + RSI Pullback</option>
              <option value="STRADDLE">⚡ ATM Straddle (Sell)</option>
              <option value="IRON_CONDOR">🛡️ Iron Condor (Credit)</option>
              <option value="BULL_PUT_SPREAD">📈 Bull Put Spread</option>
              <option value="BEAR_CALL_SPREAD">📉 Bear Call Spread</option>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Lots</label>
            <Input id="newStratLots" type="number" defaultValue={1} />
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Direction / Expiry</label>
            <Select id="newStratDirection" className="w-full">
              <option value="BULLISH">Bullish (Call Bias)</option>
              <option value="BEARISH">Bearish (Put Bias)</option>
              <option value="NEUTRAL">Neutral (Both Sides)</option>
            </Select>
          </div>
        </div>
      </div>
      <div className="flex gap-2 justify-end mt-4">
        <Button variant="ghost" onClick={closeModal}>Cancel</Button>
        <Button onClick={async () => {
          const name = (document.getElementById('newStratName') as HTMLInputElement)?.value || 'New Strategy';
          const sym = (document.getElementById('newStratSymbol') as HTMLSelectElement)?.value || 'NIFTY';
          const type = (document.getElementById('newStratType') as HTMLSelectElement)?.value || 'ORB_15M';
          const dir = (document.getElementById('newStratDirection') as HTMLSelectElement)?.value || 'BULLISH';
          const lots = parseInt((document.getElementById('newStratLots') as HTMLInputElement)?.value || '1', 10);
          const lotSize = sym === 'SENSEX' ? 20 : sym === 'BANKNIFTY' ? 30 : sym === 'FINNIFTY' ? 60 : 65;
          const qty = lots * lotSize;

          closeModal();
          try {
            const chainRes = await api.optionChain(sym).catch(() => null);
            const strikes = chainRes?.strikes || [];
            const step = sym === 'BANKNIFTY' || sym === 'SENSEX' ? 100 : 50;
            const spot = strikes.length > 0 ? strikes[Math.floor(strikes.length / 2)].strike : (sym === 'SENSEX' ? 76900 : sym === 'BANKNIFTY' ? 58000 : 24050);
            const atmStrike = Math.round(spot / step) * step;

            const isBuy = type.startsWith('ORB') || type.startsWith('VWAP');
            const side = isBuy ? 'BUY' as const : 'SELL' as const;
            const optSuffix = dir === 'BEARISH' ? 'PE' : 'CE';

            const legs = isBuy
              ? [{ instrument: `${sym}${atmStrike}${optSuffix}`, side, qty, bAvg: isBuy ? 150 : 0, sAvg: isBuy ? 0 : 150, ltp: 150, delta: optSuffix === 'CE' ? 0.55 : -0.55, gamma: 0.002, theta: -12.5, vega: 14.2 }]
              : [
                  { instrument: `${sym}${atmStrike}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 195, ltp: 195, delta: -0.5, gamma: -0.003, theta: 8.2, vega: -12.4 },
                  { instrument: `${sym}${atmStrike}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 170, ltp: 170, delta: 0.5, gamma: -0.003, theta: 7.8, vega: -11.9 },
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
