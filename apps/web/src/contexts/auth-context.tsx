"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { api } from "@/lib/api";
import type { ProjectType } from "@reformaflow/domain";

export type ModuleSlug =
  | "dashboard"
  | "expenses"
  | "receipts"
  | "cashFlow"
  | "monthlyOverview"
  | "rooms"
  | "floorPlans"
  | "simulation"
  | "priceCompare"
  | "recurringBills"
  | "maintenance"
  | "reminders"
  | "carInfo"
  | "creditCards"
  | "bankAccounts"
  | "schedule"
  | "pendencias"
  | "financialDashboard"
  | "plantsAi";

export const ALL_MODULES: { slug: ModuleSlug; label: string }[] = [
  { slug: "dashboard", label: "Dashboard" },
  { slug: "expenses", label: "Despesas" },
  { slug: "receipts", label: "Recebimentos" },
  { slug: "cashFlow", label: "Fluxo de Caixa" },
  { slug: "monthlyOverview", label: "Visão Mensal" },
  { slug: "rooms", label: "Ambientes" },
  { slug: "floorPlans", label: "Plantas" },
  { slug: "simulation", label: "Simulação" },
  { slug: "priceCompare", label: "Comparar Preços" },
  { slug: "recurringBills", label: "Contas Recorrentes" },
  { slug: "maintenance", label: "Manutenções" },
  { slug: "reminders", label: "Lembretes" },
  { slug: "carInfo", label: "Info Carro" },
  { slug: "creditCards", label: "Cartões" },
  { slug: "bankAccounts", label: "Contas Bancárias" },
  { slug: "schedule", label: "Cronograma" },
  { slug: "pendencias", label: "Pendências" },
  { slug: "financialDashboard", label: "Financeiro" },
  { slug: "plantsAi", label: "Diagnóstico IA (Plantas)" },
];

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: "ADMIN" | "USER" | string;
  tenantId: string;
  allowedModules: string[];
  allowedProjects: string[];
  allowedProjectTypes: string[];
}

export interface RegistrationInput {
  tenantName: string;
  ownerName: string;
  email?: string;
  username: string;
  password: string;
  projectTypes: ProjectType[];
}

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  isAdmin: boolean;
  hasModule: (slug: ModuleSlug) => boolean;
  hasProjectType: (type: string) => boolean;
  hasProjectAccess: (projectId: string) => boolean;
  canCreateProjectType: (type: string) => boolean;
  login: (username: string, password: string) => Promise<AuthUser>;
  register: (input: RegistrationInput, idempotencyKey: string) => Promise<AuthUser>;
  updateObjectives: (projectTypes: ProjectType[]) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<AuthUser | null>("/auth/me");
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
    const res = await api.post<{ user: AuthUser }>("/auth/login", {
      username,
      password,
    });
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(async (input: RegistrationInput, idempotencyKey: string) => {
    const res = await api.post<{ user: AuthUser }>("/auth/register", input, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
    setUser(res.user);
    return res.user;
  }, []);

  const updateObjectives = useCallback(async (projectTypes: ProjectType[]) => {
    await api.patch("/auth/objectives", { projectTypes });
    const freshUser = await api.get<AuthUser>("/auth/me");
    setUser(freshUser);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout", {});
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const isAdmin = user?.role === "ADMIN" || user?.role === "OWNER";
    const allowed = new Set(user?.allowedModules ?? []);
    const allowedProjects = user?.allowedProjects ?? [];
    const allowedProjectTypes = user?.allowedProjectTypes ?? [];
    // Project types are an explicit authorization dimension. Shared modules must
    // never imply access to an objective the person did not select.
    const hasProjectType = (type: string) =>
      isAdmin || allowedProjectTypes.includes(type);
    return {
      user,
      loading,
      isAdmin,
      hasModule: (slug: ModuleSlug) => isAdmin || allowed.has(slug),
      hasProjectType,
      // Acesso por projeto (opt-in): admin sempre; lista vazia = sem restrição;
      // lista não-vazia = só os projetos liberados.
      hasProjectAccess: (projectId: string) =>
        isAdmin ||
        allowedProjects.length === 0 ||
        allowedProjects.includes(projectId),
      canCreateProjectType: hasProjectType,
      login,
      register,
      updateObjectives,
      logout,
      refresh,
    };
  }, [user, loading, login, register, updateObjectives, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}


export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
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
      canCreateProjectType: () => false,
      login: async () => {
        throw new Error("AuthProvider not mounted");
      },
      register: async () => {
        throw new Error("AuthProvider not mounted");
      },
      updateObjectives: async () => {
        throw new Error("AuthProvider not mounted");
      },
      logout: async () => {},
      refresh: async () => {},
    };
  }
  return ctx;
}
