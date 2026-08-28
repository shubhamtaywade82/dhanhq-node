import { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { AppState, ToastType } from './types';
import { initialAppState } from '../utils/mockData';

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
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialAppState);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modalContent, setModalContent] = useState<ReactNode | null>(null);
  const toastIdRef = useRef(0);

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
    <AppContext.Provider value={{ state, setState, showToast, openModal, closeModal, toasts, modalContent, addSystemLog }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
