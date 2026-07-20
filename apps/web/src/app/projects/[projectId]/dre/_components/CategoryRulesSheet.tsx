'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';

type MerchantRule = {
  merchantKey: string;
  merchantSample: string;
  category: string;
  source: string;
};

export function CategoryRulesSheet() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: rules = [] } = useQuery<MerchantRule[]>({
    queryKey: ['merchant-rules-dre', search],
    queryFn: () =>
      api.get(
        `/merchant-categories?source=MANUAL${
          search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''
        }`,
      ),
    enabled: open,
  });

  const removeRuleMutation = useMutation({
    mutationFn: (merchant: string) =>
      api.post('/merchant-categories/remove-rule', { merchant }),
    onSuccess: () => {
      toast.success('Regra removida');
      queryClient.invalidateQueries({ queryKey: ['merchant-rules-dre'] });
      queryClient.invalidateQueries({ queryKey: ['merchant-suggest-conta'] });
    },
    onError: (e: Error) => toast.error(`Erro ao remover regra: ${e.message}`),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-white"
        title="Gerenciar regras de categoria"
      >
        <Settings className="h-4 w-4" />
        Regras
      </button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Regras de categoria"
          variant="sheet"
          size="sm"
        >
          <div className="space-y-3 pb-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar merchant"
              className="h-10 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
            />
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.merchantKey}
                  className="flex items-center justify-between gap-2 rounded-xl border border-lifeone-hairline p-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-lifeone-ink">
                      {rule.merchantSample}
                    </p>
                    <p className="text-[11px] text-lifeone-ink-3">
                      {rule.category} · origem manual
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRuleMutation.mutate(rule.merchantKey)}
                    className="rounded-lg border border-lifeone-hairline px-2 py-1 text-[11px] font-semibold text-[#D92D20] hover:bg-[#FCEBE9]"
                  >
                    Excluir
                  </button>
                </div>
              ))}
              {rules.length === 0 && (
                <p className="rounded-xl border border-dashed border-lifeone-hairline p-3 text-center text-[12px] text-lifeone-ink-3">
                  Nenhuma regra manual encontrada.
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
