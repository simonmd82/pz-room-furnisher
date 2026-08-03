import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { getTileConfigSets } from '../api/tilesApi';
import type { TileConfigSetInfo } from '../types/tiles';

interface ActiveConfigSetContextValue {
  sets: TileConfigSetInfo[];
  selectedSetId: string;
  setSelectedSetId: (id: string) => void;
  reloadSets: () => void;
}

const ActiveConfigSetContext = createContext<ActiveConfigSetContextValue | undefined>(undefined);

export function ActiveConfigSetProvider({ children }: { children: ReactNode }) {
  const [sets, setSets] = useState<TileConfigSetInfo[]>([]);
  const [selectedSetId, setSelectedSetId] = useState('vanilla');

  const reloadSets = useCallback(() => {
    getTileConfigSets().then(setSets).catch(console.error);
  }, []);

  useEffect(() => { reloadSets(); }, [reloadSets]);

  return (
    <ActiveConfigSetContext.Provider value={{ sets, selectedSetId, setSelectedSetId, reloadSets }}>
      {children}
    </ActiveConfigSetContext.Provider>
  );
}

export function useActiveConfigSet(): ActiveConfigSetContextValue {
  const ctx = useContext(ActiveConfigSetContext);
  if (!ctx) throw new Error('useActiveConfigSet must be used within an ActiveConfigSetProvider');
  return ctx;
}
