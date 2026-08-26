'use client';

import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Camera, CreditCard, Landmark, SkipForward, Wallet } from 'lucide-react';
import { ExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { maskCurrencyInputPositive, centsToReaisInput, currencyInputToNumber } from '@/lib/currency-input';
import { getExpenseOptions } from '@/app/projects/[projectId]/expenses/_types';
import { invalidateExpenseQueries } from '@/app/projects/[projectId]/expenses/_hooks/useExpenseMutations';
import { useVoiceExpense } from '@/app/projects/[projectId]/expenses/_hooks/useVoiceExpense';
import { VoiceExpenseModal } from '@/app/projects/[projectId]/expenses/_components/VoiceExpenseModal';
import { ONBOARDING_MODES } from '@/app/projects/[projectId]/_components/mobile-launch/launch-modes';
import type { LaunchMode } from '@/app/projects/[projectId]/_components/mobile-launch/launch-modes';
import type { ExpenseFormData } from '@/types';
import type { OnboardingStepProps } from '../_types';

type EntryMode = Extract<LaunchMode, 'despesa' | 'voz' | 'foto'>;
type ExpenseScreen = 'form' | 'fonte';
type FonteChoice = 'carteira' | 'bankAccount' | 'creditCard';

interface TenantCard { id: string; nickname?: string | null; brand: string; last4: string }
interface TenantAccount { id: string; nickname?: string | null; institution: string; last4?: string | null }
interface TenantProject { id: string; name: string; type: string }

/**
 * Fluxo de 2 telas (issue #320):
 * Tela 1: tipo, descrição, valor, data — sem selects de conta/cartão.
 * Tela 2 (só se funding existe): escolha mutuamente exclusiva Carteira / conta / cartão.
 * Sem funding → salva direto como Carteira (PAGO, bankAccountId: null, creditCardId: null).
 */
export function QuickExpenseStep({
  projectId,
  projectType,
  onDone,
  onSkip,
  onBack,
  subtitle,
  canSkip = true,
  funding,
}: OnboardingStepProps) {
  const options = getExpenseOptions(projectType);
  const queryClient = useQueryClient();
  /**
   * Categoria padrão: `OUTROS` quando o tipo de projeto o oferece, senão o
   * primeiro da lista.
   *
   * NÃO usar `options[0]` direto: em PESSOAL o primeiro é `CARTAO_CREDITO`, que
   * na taxonomia tem `essentiality: 'NEUTRO'` e existe para *pagamento de
   * fatura* — uma despesa não classificada nascia com um tipo que o sistema
   * trata como não-consumo, sumindo dos gastos por categoria e do resultado.
   * E amarrar em `options[0]` faz o padrão depender da ORDEM da lista:
   * reordenar categorias o mudaria sem ninguém perceber.
   *
   * O `find` é necessário porque nem todo tipo tem `OUTROS`: REFORMA e PLANTAS
   * não oferecem (ver `getExpenseTypesForProject`), e forçá-lo ali produziria
   * um tipo inválido para o projeto — trocaria um bug por outro.
   *
   * UMA constante só, usada pelo select do formulário E pelo fallback da voz:
   * eram dois pontos com a mesma regra, e corrigir um deixava o outro errado —
   * foi exatamente o que a QA visual da foto pegou.
   */
  const defaultExpenseType =
    (options.find((o) => o.value === ExpenseType.OUTROS)?.value as ExpenseType | undefined) ??
    (options[0]?.value as ExpenseType) ??
    ExpenseType.OUTROS;
  const [mode, setMode] = useState<EntryMode>('despesa');
  const [expenseScreen, setExpenseScreen] = useState<ExpenseScreen>('form');
  const [fonteChoice, setFonteChoice] = useState<FonteChoice>('carteira');

  // ─── Despesa form state ───────────────────────────────────────────────────
  const [tipoDespesa, setTipoDespesa] = useState<string>(defaultExpenseType);
  const [valor, setValor] = useState('');
  const [titulo, setTitulo] = useState('');
  const [dataPagamento, setDataPagamento] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  // Leitura da foto do comprovante: separado de `saving` porque são etapas
  // diferentes — a foto é interpretada ANTES de salvar, e o usuário ainda vai
  // confirmar os campos no formulário.
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Foto ref ─────────────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null);

  // ─── Tenant queries (voz context + labels na tela de fonte) ───────────────
  const hasFunding = !!(funding?.bankAccount || funding?.creditCard);
  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });
  const { data: tenantProjects = [] } = useQuery<TenantProject[]>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
    enabled: mode === 'voz',
  });

  // ─── Voice expense hook ───────────────────────────────────────────────────
  const voice = useVoiceExpense({
    allowedExpenseTypes: options.map((o) => o.value as ExpenseType),
    defaultExpenseType,
    onCreate: (data: ExpenseFormData, onSuccess: () => void) => {
      // Sem `.catch(() => {})`: engolir o erro aqui fazia a despesa por voz
      // falhar em silêncio — o modal fechava, o passo avançava, e o usuário só
      // descobria depois que nada tinha sido salvo. Agora a falha aparece no
      // mesmo `setError` que o formulário manual já usa, e o passo NÃO avança.
      setError(null);
      api
        .post(`/projects/${projectId}/expenses`, data)
        .then(() => {
          // Sem invalidar, a despesa salva não aparecia nas listas já carregadas
          // (Despesas, Cockpit, Visão Conta) — o usuário lançava e "sumia".
          // Reusa o MESMO helper da tela normal para não divergir: se um dia
          // entrar uma query nova lá, a jornada acompanha de graça.
          invalidateExpenseQueries(queryClient, projectId);
          onSuccess();
          onDone(expenseDonePayload(data.tipoDespesa));
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : 'Erro ao salvar despesa por voz');
        });
    },
    cards,
    accounts,
    projects: tenantProjects,
    currentProjectId: projectId,
  });

  const canSubmit = valor.trim().length > 0 && currencyInputToNumber(valor) > 0;
  const savingRef = useRef(false);

  // Deriva o payload que habilita o MariaInsightStep a partir do tipo de
  // despesa, reusando os labels de `getExpenseOptions` (não recria mapa).
  function expenseDonePayload(tipo: string) {
    const categoriaLabel = options.find((o) => o.value === tipo)?.label ?? '';
    return { createdExpense: { tipoDespesa: tipo, categoriaLabel } };
  }

  function buildPayload(bankAccountId: string | null, creditCardId: string | null) {
    return {
      tipoDespesa,
      valor: currencyInputToNumber(valor),
      quantidade: 1,
      formaPagamento: 'A_VISTA',
      status: 'PAGO',
      dataPagamento,
      titulo: titulo.trim() || undefined,
      creditCardId,
      bankAccountId,
    };
  }

  async function handleSave(bankAccountId: string | null, creditCardId: string | null) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/expenses`, buildPayload(bankAccountId, creditCardId));
      // Mesmo motivo do caminho por voz: sem invalidar, a despesa salva não
      // aparece nas listas já carregadas quando a jornada termina.
      invalidateExpenseQueries(queryClient, projectId);
      onDone(expenseDonePayload(tipoDespesa));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar despesa');
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  }

  function handleFormContinuar() {
    if (!canSubmit) return;
    if (!hasFunding) {
      // Sem fontes → salva direto como Carteira
      void handleSave(null, null);
    } else {
      setExpenseScreen('fonte');
    }
  }

  function handleFonteSubmit() {
    const bankAccountId = fonteChoice === 'bankAccount' ? (funding?.bankAccount?.id ?? null) : null;
    const creditCardId = fonteChoice === 'creditCard' ? (funding?.creditCard?.id ?? null) : null;
    void handleSave(bankAccountId, creditCardId);
  }

  /**
   * Foto de comprovante (cupom, print de PIX, recibo) → OCR → **formulário
   * preenchido para conferência**, nunca gravação direta.
   *
   * Antes isto era um stub que só chamava `onDone()`: o usuário fotografava, a
   * tela avançava e nada era salvo. Agora envia a imagem, e o que a IA leu cai
   * nos campos do formulário para o usuário conferir e salvar — mesmo contrato
   * do fluxo de voz, que também interpreta e deixa a decisão com quem lançou.
   * Gravar direto a partir de OCR seria dinheiro entrando no consolidado sem
   * ninguém ter olhado o valor.
   *
   * Campo que a IA não leu fica em branco (ou no default) em vez de chutar.
   */
  async function handleFotoSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Limpa o input para permitir reenviar a MESMA foto depois de um erro —
    // sem isto o `change` não dispara de novo e o botão parece morto.
    e.target.value = '';
    if (!file) return;

    setError(null);
    setScanning(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const scan = await api.upload<{
        valorCents: number | null;
        fornecedor: string | null;
        descricao: string | null;
        data: string | null;
      }>(`/projects/${projectId}/expenses/scan-receipt`, fd, { timeoutMs: 70000 });

      if (scan.valorCents != null) setValor(centsToReaisInput(scan.valorCents));
      const tituloLido = scan.descricao ?? scan.fornecedor;
      if (tituloLido) setTitulo(tituloLido);
      if (scan.data) setDataPagamento(scan.data);

      if (scan.valorCents == null) {
        setError(
          'Não consegui ler o valor nessa foto. Confira os campos e complete o que faltar.',
        );
      }
      // Volta para o formulário com o que foi lido — o usuário confirma pelo
      // fluxo normal ("Criar e continuar"), inclusive escolhendo a fonte.
      setMode('despesa');
      setExpenseScreen('form');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao ler a foto do comprovante');
    } finally {
      setScanning(false);
    }
  }

  // Labels para a tela de fonte
  const fundingAccount = accounts.find((a) => a.id === funding?.bankAccount?.id);
  const fundingCard = cards.find((c) => c.id === funding?.creditCard?.id);

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Sua primeira despesa</h2>
      <p className="text-[13px] text-lifeone-ink-3">
        {subtitle || 'Registre um gasto recente para começar a acompanhar o caixa'}
      </p>

      {/* Mode picker — só na tela form */}
      {expenseScreen === 'form' && (
        <div className="mt-4 flex gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface p-1">
          {ONBOARDING_MODES.filter((m) => m.value !== 'voz' || voice.voiceSupported).map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value as EntryMode)}
              className={[
                'flex-1 min-h-11 rounded-[8px] px-3 py-2 text-[13px] font-medium transition-colors',
                mode === m.value
                  ? 'bg-lifeone-blue text-white shadow-sm'
                  : 'text-lifeone-ink-2 hover:bg-lifeone-hairline/60',
              ].join(' ')}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      {/* ─── TELA 1: Formulário ────────────────────────────────────────── */}
      {expenseScreen === 'form' && mode === 'despesa' && (
        <>
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="qe-tipo" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Tipo</label>
              <select
                id="qe-tipo"
                value={tipoDespesa}
                onChange={(e) => setTipoDespesa(e.target.value)}
                className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
              >
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="qe-titulo" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Descrição (opcional)</label>
              <input
                id="qe-titulo"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder="Ex: Mercado do mês"
                className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="qe-valor" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Valor (R$)</label>
                <input
                  id="qe-valor"
                  value={valor}
                  onChange={(e) => setValor(maskCurrencyInputPositive(e.target.value))}
                  placeholder="150,00"
                  inputMode="numeric"
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] font-mono placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
                />
              </div>
              <div>
                <label htmlFor="qe-data" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Data</label>
                <input
                  id="qe-data"
                  type="date"
                  value={dataPagamento}
                  onChange={(e) => setDataPagamento(e.target.value)}
                  className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px]"
                />
              </div>
            </div>
          </div>

          {error && <p className="mt-3 text-[13px] text-[#B42318]">{error}</p>}

          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={handleFormContinuar}
              disabled={!canSubmit || saving}
              aria-describedby={!canSubmit ? 'qe-helper' : undefined}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Salvando…' : 'Criar e continuar'}
              {!saving && <ArrowRight className="h-4 w-4" />}
            </button>
            {!canSubmit && <p id="qe-helper" className="text-[12px] text-lifeone-ink-3">Informe um valor maior que zero para continuar.</p>}
            <button
              onClick={onSkip}
              className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
            >
              <SkipForward className="h-3.5 w-3.5" /> Pular por agora
            </button>
            {onBack && (
              <button
                onClick={onBack}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] font-medium text-lifeone-ink-3 hover:text-lifeone-ink transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Voltar
              </button>
            )}
          </div>
        </>
      )}

      {/* ─── TELA 2: Escolha de fonte (mutuamente exclusiva) ──────────── */}
      {expenseScreen === 'fonte' && (
        <>
          <p className="mt-4 text-[13px] text-lifeone-ink-2">Como foi pago?</p>
          <div className="mt-3 space-y-2">
            {/* Carteira */}
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 transition-colors has-[:checked]:border-lifeone-blue has-[:checked]:bg-lifeone-blue/5">
              <input
                type="radio"
                name="fonte"
                value="carteira"
                checked={fonteChoice === 'carteira'}
                onChange={() => setFonteChoice('carteira')}
                className="accent-lifeone-blue"
              />
              <Wallet className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
              <span className="text-[14px] text-lifeone-ink">Carteira</span>
            </label>

            {/* Conta bancária */}
            {funding?.bankAccount && (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 transition-colors has-[:checked]:border-lifeone-blue has-[:checked]:bg-lifeone-blue/5">
                <input
                  type="radio"
                  name="fonte"
                  value="bankAccount"
                  checked={fonteChoice === 'bankAccount'}
                  onChange={() => setFonteChoice('bankAccount')}
                  className="accent-lifeone-blue"
                />
                <Landmark className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
                <span className="text-[14px] text-lifeone-ink">
                  {fundingAccount
                    ? (fundingAccount.nickname || `${fundingAccount.institution}${fundingAccount.last4 ? ` ••${fundingAccount.last4}` : ''}`)
                    : 'Conta bancária'}
                </span>
              </label>
            )}

            {/* Cartão */}
            {funding?.creditCard && (
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 transition-colors has-[:checked]:border-lifeone-blue has-[:checked]:bg-lifeone-blue/5">
                <input
                  type="radio"
                  name="fonte"
                  value="creditCard"
                  checked={fonteChoice === 'creditCard'}
                  onChange={() => setFonteChoice('creditCard')}
                  className="accent-lifeone-blue"
                />
                <CreditCard className="h-4 w-4 shrink-0 text-lifeone-ink-3" />
                <span className="text-[14px] text-lifeone-ink">
                  {fundingCard
                    ? (fundingCard.nickname || `${fundingCard.brand} ••${fundingCard.last4}`)
                    : 'Cartão de crédito'}
                </span>
              </label>
            )}
          </div>

          {error && <p className="mt-3 text-[13px] text-[#B42318]">{error}</p>}

          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={handleFonteSubmit}
              disabled={saving}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Salvando…' : 'Confirmar'}
              {!saving && <ArrowRight className="h-4 w-4" />}
            </button>
            <button
              onClick={() => { setExpenseScreen('form'); setError(null); }}
              className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Voltar
            </button>
          </div>
        </>
      )}

      {/* ─── VOZ mode ─────────────────────────────────────────────────────── */}
      {expenseScreen === 'form' && mode === 'voz' && (
        <>
          <VoiceExpenseModal
            open
            onClose={() => setMode('despesa')}
            voiceSupported={voice.voiceSupported}
            voiceListening={voice.voiceListening}
            voiceTranscript={voice.voiceTranscript}
            voiceError={voice.voiceError}
            voiceData={voice.voiceData}
            setVoiceData={voice.setVoiceData}
            voiceFornecedor={voice.voiceFornecedor}
            setVoiceFornecedor={voice.setVoiceFornecedor}
            voiceLinkedExpenseId={voice.voiceLinkedExpenseId}
            setVoiceLinkedExpenseId={voice.setVoiceLinkedExpenseId}
            startVoiceCapture={voice.startVoiceCapture}
            clearVoiceTranscript={voice.clearVoiceTranscript}
            saveVoiceExpense={voice.saveVoiceExpense}
            saveDisabled={!voice.voiceData?.valor}
            tipoDespesaOptions={options}
            cards={cards}
            accounts={accounts}
            voiceLinkedProject={voice.voiceLinkedProject}
            currentProjectId={projectId}
          />
          <div className="mt-5 flex flex-col gap-2">
            {canSkip && (
              <button
                onClick={onSkip}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
              >
                <SkipForward className="h-3.5 w-3.5" /> Pular por agora
              </button>
            )}
            {onBack && (
              <button
                onClick={onBack}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] font-medium text-lifeone-ink-3 hover:text-lifeone-ink transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Voltar
              </button>
            )}
          </div>
        </>
      )}

      {/* ─── FOTO mode ────────────────────────────────────────────────────── */}
      {expenseScreen === 'form' && mode === 'foto' && (
        <>
          <div className="mt-6 flex flex-col items-center gap-4 py-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-lifeone-surface">
              <Camera className="h-8 w-8 text-lifeone-ink-3" />
            </div>
            <p className="text-center text-[14px] text-lifeone-ink-2">
              {scanning
                ? 'Lendo o comprovante…'
                : 'Fotografe o comprovante ou nota fiscal'}
            </p>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              ref={fileRef}
              onChange={handleFotoSelected}
            />
            <button
              type="button"
              disabled={scanning}
              onClick={() => fileRef.current?.click()}
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:opacity-60"
            >
              <Camera className="h-4 w-4" />{' '}
              {scanning ? 'Lendo…' : 'Tirar foto / escolher imagem'}
            </button>
            {/* O erro precisa aparecer AQUI: numa falha de leitura o usuário
                continua no modo foto, e sem este bloco a mensagem ficava só no
                bloco de `despesa` — invisível, e a tela parecia travada. */}
            {error && (
              <p className="mt-1 text-center text-[13px] text-[#B42318]">{error}</p>
            )}
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {canSkip && (
              <button
                onClick={onSkip}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
              >
                <SkipForward className="h-3.5 w-3.5" /> Pular por agora
              </button>
            )}
            {onBack && (
              <button
                onClick={onBack}
                className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] font-medium text-lifeone-ink-3 hover:text-lifeone-ink transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Voltar
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
