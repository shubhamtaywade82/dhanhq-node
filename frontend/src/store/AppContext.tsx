import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AppState, ToastType } from './types';
import { initialAppState } from '../utils/mockData';
import { api } from '../services/api';

interface Toast {
  id: number;
  msg: string;
  type: ToastType;
}

interface AppContextValue {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  showToast: (msg: string, type?: ToastType) => void;
  openModal: (content: ReactNode) => void;
  closeModal: () => void;
  toasts: Toast[];
  modalContent: ReactNode | null;
  addSystemLog: (level: string, message: string, source?: string) => void;
  connected: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialAppState);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalContent, setModalContent] = useState<ReactNode | null>(null);
  const [connected, setConnected] = useState(false);
  const toastIdRef = useRef(0);

  // Fetch initial data from API on mount
  useEffect(() => {
    let mounted = true;

    async function fetchInitialData() {
      try {
        const health = await api.health();
        if (!mounted) return;
        setConnected(true);
        console.log('[API] Connected:', health.mode);
      } catch {
        if (mounted) setConnected(false);
      }

      try {
        const indices = await api.indices();
        if (!mounted) return;
        setState((prev) => ({ ...prev, indices }));
      } catch {
        // Use mock data as fallback
      }

      try {
        const [positions, orders, funds] = await Promise.all([
          api.positions().catch(() => []),
          api.orders().catch(() => []),
          api.funds().catch(() => ({})),
        ]);
        if (!mounted) return;
        setState((prev) => ({
          ...prev,
          positions: Array.isArray(positions) ? positions : prev.positions,
          orders: Array.isArray(orders) ? orders : prev.orders,
          funds: typeof funds === 'object' ? { ...prev.funds, ...(funds as any) } : prev.funds,
        }));
      } catch {
        // Use mock data as fallback
      }
    }

    fetchInitialData();

    // Poll indices every 5s
    const interval = setInterval(async () => {
      try {
        const indices = await api.indices();
        if (mounted) {
          setState((prev) => ({ ...prev, indices }));
        }
      } catch {
        // Silent fail
      }
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const showToast = useCallback((msg: string, type: ToastType = 'success') => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  const openModal = useCallback((content: ReactNode) => {
    setModalContent(content);
  }, []);

  const closeModal = useCallback(() => {
    setModalContent(null);
  }, []);

  const addSystemLog = useCallback(
    (level: string, message: string, source = 'system') => {
      const id = ++state.logIdCounter;
      const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const reqId = `req_${Math.random().toString(36).substring(2, 8)}`;
      setState((prev) => {
        const logs = [...prev.logs, { id, time, level, message, source, reqId }];
        return { ...prev, logs: logs.length > 400 ? logs.slice(-400) : logs, logIdCounter: id };
      });
    },
    [state.logIdCounter],
  );

  return (
    <AppContext.Provider value={{ state, setState, showToast, openModal, closeModal, toasts, modalContent, addSystemLog, connected }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
