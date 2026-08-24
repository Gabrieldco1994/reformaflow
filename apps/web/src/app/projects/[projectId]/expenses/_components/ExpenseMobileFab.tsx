import { Plus } from 'lucide-react';

/**
 * FAB de "nova despesa" no mobile. Só existe para os tipos que renderizam o
 * `ExpensesView` como a PRÓPRIA tela mobile (REFORMA/COMPRA/CASA/CARRO).
 *
 * NÃO recebe mais `personal`: em PESSOAL este FAB nunca chegou a aparecer —
 * lá o `ExpensesView` é renderizado dentro de um container `hidden lg:block`
 * (só-desktop) enquanto o botão é `md:hidden` (só-mobile), então a caixa
 * nunca era gerada (`getBoundingClientRect` = 0×0). A superfície mobile do
 * PESSOAL é o `MobileExpensesScreen`, e o lançamento ali é o "Lançar" central
 * do `MobileTabBar`. O posicionamento alternativo que existia para `personal`
 * era código morto desde a origem.
 */
export function ExpenseMobileFab({ activeTab, onClick }: { activeTab: 'despesas' | 'compraveis'; onClick: () => void }) {
  if (activeTab === 'compraveis') return null;
  return (
    <button type="button" onClick={onClick} aria-label="Nova despesa" data-journey-action="expense.new" data-launcher="true"
      className="minimal-floating-fab md:hidden fixed left-4 z-30 flex h-14 w-14 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-orange-500 text-white shadow-darc-hero active:scale-95 transition-transform">
      <Plus className="h-6 w-6" />
    </button>
  );
}
