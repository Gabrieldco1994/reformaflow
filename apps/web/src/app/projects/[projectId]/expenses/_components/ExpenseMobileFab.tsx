import { Plus } from 'lucide-react';

export function ExpenseMobileFab({ activeTab, onClick, personal = false }: { activeTab: 'despesas' | 'compraveis'; onClick: () => void; personal?: boolean }) {
  if (activeTab === 'compraveis') return null;
  return (
    <button type="button" onClick={onClick} aria-label="Nova despesa"
      className={`md:hidden fixed left-4 z-30 flex h-14 w-14 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-orange-500 text-white shadow-darc-hero active:scale-95 transition-transform ${personal ? 'bottom-[calc(6rem+env(safe-area-inset-bottom))]' : 'bottom-[calc(5rem+env(safe-area-inset-bottom))]'}`}>
      <Plus className="h-6 w-6" />
    </button>
  );
}
