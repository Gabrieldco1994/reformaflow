import { create } from 'zustand';

interface CopilotStore {
  open: boolean;
  setOpen: (o: boolean) => void;
  toggle: () => void;
}

export const useCopilotStore = create<CopilotStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
