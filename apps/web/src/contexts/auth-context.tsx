'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from '@/lib/api';

export type ModuleSlug =
  | 'dashboard'
  | 'expenses'
  | 'receipts'
  | 'cashFlow'
  | 'monthlyOverview'
  | 'rooms'
  | 'floorPlans'
  | 'simulation'
  | 'priceCompare'
  | 'recurringBills'
  | 'maintenance'
  | 'reminders'
  | 'carInfo'
  | 'creditCards'
  | 'bankAccounts'
  | 'schedule';

export const ALL_MODULES: { slug: ModuleSlug; label: string }[] = [
  { slug: 'dashboard', label: 'Dashboard' },
  { slug: 'expenses', label: 'Despesas' },
  { slug: 'receipts', label: 'Recebimentos' },
  { slug: 'cashFlow', label: 'Fluxo de Caixa' },
  { slug: 'monthlyOverview', label: 'Visão Mensal' },
  { slug: 'rooms', label: 'Ambientes' },
  { slug: 'floorPlans', label: 'Plantas' },
  { slug: 'simulation', label: 'Simulação' },
  { slug: 'priceCompare', label: 'Comparar Preços' },
  { slug: 'recurringBills', label: 'Contas Recorrentes' },
  { slug: 'maintenance', label: 'Manutenções' },
  { slug: 'reminders', label: 'Lembretes' },
  { slug: 'carInfo', label: 'Info Carro' },
  { slug: 'creditCards', label: 'Cartões' },
  { slug: 'bankAccounts', label: 'Contas Bancárias' },
  { slug: 'schedule', label: 'Cronograma' },
];

export const TYPE_MODULES: Record<string, ModuleSlug[]> = {
  REFORMA: ['expenses', 'receipts', 'cashFlow', 'schedule', 'floorPlans', 'simulation', 'priceCompare', 'rooms'],
  COMPRA: ['expenses', 'receipts', 'cashFlow'],
  PESSOAL: ['monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts'],
  CASA: ['recurringBills', 'maintenance', 'reminders', 'expenses'],
  CARRO: ['carInfo', 'recurringBills', 'maintenance', 'reminders', 'expenses'],
};

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: 'ADMIN' | 'USER' | string;
  tenantId: string;
  allowedModules: string[];
  allowedProjects: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  hasModule: (slug: ModuleSlug) => boolean;
  hasProjectType: (type: string) => boolean;
  hasProjectAccess: (projectId: string) => boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<AuthUser | null>('/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<{ user: AuthUser }>('/auth/login', {
      username,
      password,
    });
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const isAdmin = user?.role === 'ADMIN' || user?.role === 'OWNER';
    const allowed = new Set(user?.allowedModules ?? []);
    const allowedProjects = user?.allowedProjects ?? [];
    return {
      user,
      loading,
      isAdmin,
      hasModule: (slug: ModuleSlug) => isAdmin || allowed.has(slug),
      hasProjectType: (type: string) => {
        if (isAdmin) return true;
        const mods = TYPE_MODULES[type] ?? [];
        return mods.some((m) => allowed.has(m));
      },
      // Acesso por projeto (opt-in): admin sempre; lista vazia = sem restrição;
      // lista não-vazia = só os projetos liberados.
      hasProjectAccess: (projectId: string) =>
        isAdmin || allowedProjects.length === 0 || allowedProjects.includes(projectId),
      login,
      logout,
      refresh,
    };
  }, [user, loading, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      user: null,
      loading: true,
      isAdmin: false,
      hasModule: () => false,
      hasProjectType: () => false,
      hasProjectAccess: () => false,
      login: async () => {
        throw new Error('AuthProvider not mounted');
      },
      logout: async () => {},
      refresh: async () => {},
    };
  }
  return ctx;
}
