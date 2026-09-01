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
              <option value="MIDCPNIFTY">MIDCPNIFTY (Lot: 120)</option>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-mono text-muted uppercase block mb-1">Strategy Engine</label>
            <Select id="newStratType" className="w-full">
              <option value="ORB_15M">🚀 15m Spot ORB (Buy ATM CE/PE)</option>
              <option value="ORB_30M">⏱️ 30m Spot ORB (Buy Breakout)</option>
              <option value="ORB_PREM_200">🎯 ₹200 ITM Premium ORB</option>
              <option value="VWAP_RSI">🌊 VWAP + RSI Pullback (Buy)</option>
              <option value="EMA_CROSSOVER">📈 9/21 EMA Trend Following</option>
              <option value="IRON_CONDOR">🛡️ Iron Condor (4-Leg Delta 0.25 Credit)</option>
              <option value="IRON_BUTTERFLY">🦋 Iron Butterfly (ATM Straddle + Wings)</option>
              <option value="BULL_PUT_SPREAD">📈 Bull Put Spread (Credit)</option>
              <option value="BEAR_CALL_SPREAD">📉 Bear Call Spread (Credit)</option>
              <option value="BULL_CALL_SPREAD">🚀 Bull Call Spread (Debit)</option>
              <option value="BEAR_PUT_SPREAD">🔻 Bear Put Spread (Debit)</option>
              <option value="STRADDLE">⚡ ATM Short Straddle (Sell CE + PE)</option>
              <option value="LONG_STRADDLE">💥 ATM Long Straddle (Buy CE + PE)</option>
              <option value="STRANGLE">🦅 OTM Short Strangle (Sell CE + PE)</option>
              <option value="LONG_STRANGLE">🌪️ OTM Long Strangle (Buy CE + PE)</option>
              <option value="RATIO_SPREAD">⚖️ 1x2 Ratio Spread (Credit/Low Debit)</option>
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
          const lotSize = sym === 'SENSEX' ? 20 : sym === 'BANKNIFTY' ? 30 : sym === 'FINNIFTY' ? 60 : sym === 'MIDCPNIFTY' ? 120 : 65;
          const qty = lots * lotSize;

          closeModal();
          try {
            const chainRes = await api.optionChain(sym).catch(() => null);
            const strikes = chainRes?.strikes || [];
            const step = sym === 'BANKNIFTY' || sym === 'SENSEX' ? 100 : sym === 'MIDCPNIFTY' ? 25 : 50;
            const spot = strikes.length > 0 ? strikes[Math.floor(strikes.length / 2)].strike : (sym === 'SENSEX' ? 76900 : sym === 'BANKNIFTY' ? 58000 : sym === 'MIDCPNIFTY' ? 12800 : sym === 'FINNIFTY' ? 25900 : 24050);
            const atmStrike = Math.round(spot / step) * step;
            const otmUp = atmStrike + step * 2;
            const otmDown = atmStrike - step * 2;
            const farUp = atmStrike + step * 5;
            const farDown = atmStrike - step * 5;

            let legs: any[] = [];
            const optSuffix = dir === 'BEARISH' ? 'PE' : 'CE';

            if (type === 'IRON_CONDOR') {
              legs = [
                { instrument: `${sym}${farDown}PE`, side: 'BUY' as const, qty, bAvg: 25, sAvg: 0, ltp: 25, delta: 0.10, gamma: 0.001, theta: -2.5, vega: 4.2 },
                { instrument: `${sym}${farUp}CE`, side: 'BUY' as const, qty, bAvg: 22, sAvg: 0, ltp: 22, delta: 0.10, gamma: 0.001, theta: -2.2, vega: 3.9 },
                { instrument: `${sym}${otmDown}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 65, ltp: 65, delta: -0.25, gamma: -0.002, theta: 6.5, vega: -8.5 },
                { instrument: `${sym}${otmUp}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 58, ltp: 58, delta: -0.25, gamma: -0.002, theta: 5.8, vega: -7.8 },
              ];
            } else if (type === 'IRON_BUTTERFLY') {
              legs = [
                { instrument: `${sym}${farDown}PE`, side: 'BUY' as const, qty, bAvg: 25, sAvg: 0, ltp: 25, delta: 0.15, gamma: 0.001, theta: -3.0, vega: 5.0 },
                { instrument: `${sym}${farUp}CE`, side: 'BUY' as const, qty, bAvg: 22, sAvg: 0, ltp: 22, delta: 0.15, gamma: 0.001, theta: -2.8, vega: 4.8 },
                { instrument: `${sym}${atmStrike}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 160, ltp: 160, delta: -0.50, gamma: -0.003, theta: 12.0, vega: -14.0 },
                { instrument: `${sym}${atmStrike}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 175, ltp: 175, delta: -0.50, gamma: -0.003, theta: 12.5, vega: -14.5 },
              ];
            } else if (type === 'BULL_PUT_SPREAD') {
              legs = [
                { instrument: `${sym}${farDown}PE`, side: 'BUY' as const, qty, bAvg: 30, sAvg: 0, ltp: 30, delta: 0.15, gamma: 0.001, theta: -3.5, vega: 5.2 },
                { instrument: `${sym}${otmDown}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 75, ltp: 75, delta: -0.30, gamma: -0.002, theta: 8.0, vega: -9.5 },
              ];
            } else if (type === 'BEAR_CALL_SPREAD') {
              legs = [
                { instrument: `${sym}${farUp}CE`, side: 'BUY' as const, qty, bAvg: 28, sAvg: 0, ltp: 28, delta: 0.15, gamma: 0.001, theta: -3.2, vega: 4.9 },
                { instrument: `${sym}${otmUp}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 70, ltp: 70, delta: -0.30, gamma: -0.002, theta: 7.5, vega: -9.0 },
              ];
            } else if (type === 'BULL_CALL_SPREAD') {
              legs = [
                { instrument: `${sym}${atmStrike}CE`, side: 'BUY' as const, qty, bAvg: 160, sAvg: 0, ltp: 160, delta: 0.50, gamma: 0.003, theta: -11.0, vega: 13.5 },
                { instrument: `${sym}${otmUp}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 65, ltp: 65, delta: -0.25, gamma: -0.002, theta: 6.5, vega: -8.0 },
              ];
            } else if (type === 'BEAR_PUT_SPREAD') {
              legs = [
                { instrument: `${sym}${atmStrike}PE`, side: 'BUY' as const, qty, bAvg: 155, sAvg: 0, ltp: 155, delta: 0.50, gamma: 0.003, theta: -10.5, vega: 13.0 },
                { instrument: `${sym}${otmDown}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 60, ltp: 60, delta: -0.25, gamma: -0.002, theta: 6.0, vega: -7.5 },
              ];
            } else if (type === 'STRADDLE' || type === 'SHORT_STRADDLE') {
              legs = [
                { instrument: `${sym}${atmStrike}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 180, ltp: 180, delta: -0.50, gamma: -0.003, theta: 12.0, vega: -14.0 },
                { instrument: `${sym}${atmStrike}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 165, ltp: 165, delta: 0.50, gamma: -0.003, theta: 11.5, vega: -13.5 },
              ];
            } else if (type === 'LONG_STRADDLE') {
              legs = [
                { instrument: `${sym}${atmStrike}CE`, side: 'BUY' as const, qty, bAvg: 180, sAvg: 0, ltp: 180, delta: 0.50, gamma: 0.003, theta: -12.0, vega: 14.0 },
                { instrument: `${sym}${atmStrike}PE`, side: 'BUY' as const, qty, bAvg: 165, sAvg: 0, ltp: 165, delta: -0.50, gamma: 0.003, theta: -11.5, vega: 13.5 },
              ];
            } else if (type === 'STRANGLE' || type === 'SHORT_STRANGLE') {
              legs = [
                { instrument: `${sym}${otmUp}CE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 70, ltp: 70, delta: -0.25, gamma: -0.002, theta: 7.0, vega: -8.5 },
                { instrument: `${sym}${otmDown}PE`, side: 'SELL' as const, qty, bAvg: 0, sAvg: 65, ltp: 65, delta: 0.25, gamma: -0.002, theta: 6.5, vega: -8.0 },
              ];
            } else if (type === 'LONG_STRANGLE') {
              legs = [
                { instrument: `${sym}${otmUp}CE`, side: 'BUY' as const, qty, bAvg: 70, sAvg: 0, ltp: 70, delta: 0.25, gamma: 0.002, theta: -7.0, vega: 8.5 },
                { instrument: `${sym}${otmDown}PE`, side: 'BUY' as const, qty, bAvg: 65, sAvg: 0, ltp: 65, delta: -0.25, gamma: 0.002, theta: -6.5, vega: 8.0 },
              ];
            } else if (type === 'RATIO_SPREAD') {
              legs = [
                { instrument: `${sym}${atmStrike}${optSuffix}`, side: 'BUY' as const, qty, bAvg: 160, sAvg: 0, ltp: 160, delta: 0.50, gamma: 0.003, theta: -11.0, vega: 13.5 },
                { instrument: `${sym}${dir === 'BULLISH' ? otmUp : otmDown}${optSuffix}`, side: 'SELL' as const, qty: qty * 2, bAvg: 0, sAvg: 75, ltp: 75, delta: -0.60, gamma: -0.004, theta: 15.0, vega: -17.0 },
              ];
            } else {
              // Directional single leg (ORB, VWAP, EMA, NAKED_BUY)
              legs = [
                { instrument: `${sym}${atmStrike}${optSuffix}`, side: 'BUY' as const, qty, bAvg: 150, sAvg: 0, ltp: 150, delta: optSuffix === 'CE' ? 0.55 : -0.55, gamma: 0.002, theta: -12.5, vega: 14.2 },
              ];
            }

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
