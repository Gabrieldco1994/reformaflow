import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ExpenseType,
  PaymentForm,
  type ParsedVoiceExpense,
  type VoiceMatchableAccount,
  type VoiceMatchableCard,
  type VoiceMatchableProject,
  parseVoiceExpense,
} from '@reformaflow/domain';
import type { ExpenseFormData } from '@/types';

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult:
    | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

interface UseVoiceExpenseArgs {
  /** Tipos de despesa permitidos (depende do projectType). */
  allowedExpenseTypes: ExpenseType[];
  defaultExpenseType: ExpenseType;
  /** Chamado para persistir a despesa interpretada do áudio. */
  onCreate: (data: ExpenseFormData, onSuccess: () => void) => void;
  /** Cartões disponíveis no tenant — para auto-vínculo via voz. */
  cards?: VoiceMatchableCard[];
  /** Contas bancárias do tenant — idem. */
  accounts?: VoiceMatchableAccount[];
  /** Projetos do tenant — para detectar cross-project ("para a reforma"). */
  projects?: VoiceMatchableProject[];
  /** ID do projeto atual — usado para excluir auto-link cross para o próprio projeto. */
  currentProjectId?: string;
}

/**
 * Encapsula a captura e parsing de despesas via reconhecimento de voz
 * (Web Speech API). O hook expõe estado da modal + callbacks; o consumidor
 * decide quando renderizar a UI e como persistir.
 */
export function useVoiceExpense({
  allowedExpenseTypes,
  defaultExpenseType,
  onCreate,
  cards,
  accounts,
  projects,
  currentProjectId,
}: UseVoiceExpenseArgs) {
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [voiceData, setVoiceData] = useState<ParsedVoiceExpense | null>(null);
  const [voiceFornecedor, setVoiceFornecedor] = useState('');
  /** ID da despesa já existente em outro projeto, escolhida pelo usuário para vincular. */
  const [voiceLinkedExpenseId, setVoiceLinkedExpenseId] = useState<string>('');
  const [speechApi, setSpeechApi] = useState<SpeechRecognitionCtor | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
    // IMPORTANTE: React trata o argumento de useState como updater function quando é função.
    // Como SpeechRecognition é um construtor (function), precisamos wrappear em callback
    // para guardá-lo como valor, e não invocá-lo. Sem isso: TypeError "use 'new' operator".
    setSpeechApi(() => ctor);
    setVoiceSupported(Boolean(ctor));
  }, []);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {
        // no-op: navegadores podem lançar se já estiver parado
      } finally {
        recognitionRef.current = null;
      }
    };
  }, []);

  const parseVoiceTranscript = useCallback(
    (rawText: string): ParsedVoiceExpense =>
      parseVoiceExpense({
        transcript: rawText,
        allowedExpenseTypes,
        defaultExpenseType,
        cards,
        accounts,
        projects,
        currentProjectId,
      }),
    [allowedExpenseTypes, defaultExpenseType, cards, accounts, projects, currentProjectId],
  );

  const startVoiceCapture = useCallback(() => {
    if (!speechApi) {
      setVoiceError('Seu navegador não suporta lançamento por voz.');
      return;
    }
    setVoiceError('');
    setVoiceTranscript('');
    setVoiceData(null);
    setVoiceFornecedor('');
    setVoiceLinkedExpenseId('');

    try {
      recognitionRef.current?.stop();
      const recognition = new speechApi();
      recognitionRef.current = recognition;
      recognition.lang = 'pt-BR';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => setVoiceListening(true);
      recognition.onend = () => setVoiceListening(false);
      recognition.onerror = (event) => {
        setVoiceListening(false);
        if (event.error === 'not-allowed') {
          setVoiceError('Microfone bloqueado. Libere a permissão para continuar.');
          return;
        }
        setVoiceError('Não consegui captar sua voz. Tente novamente.');
      };
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript?.trim() ?? '';
        setVoiceTranscript(text);
        if (!text) {
          setVoiceError('Não consegui entender o áudio.');
          setVoiceData(null);
          return;
        }
        try {
          const parsed = parseVoiceTranscript(text);
          setVoiceData(parsed);
          setVoiceFornecedor('');
          if (!parsed.valor) {
            setVoiceError(
              'Não consegui identificar o valor. Fale algo como "gastei 85 reais no mercado".',
            );
          } else {
            setVoiceError('');
          }
        } catch {
          setVoiceData(null);
          setVoiceError('Ocorreu um erro ao interpretar o comando de voz.');
        }
      };
      recognition.start();
    } catch {
      setVoiceListening(false);
      setVoiceError('Falha ao iniciar o microfone neste dispositivo.');
    }
  }, [parseVoiceTranscript, speechApi]);

  const resetVoiceState = useCallback(() => {
    setVoiceError('');
    setVoiceTranscript('');
    setVoiceData(null);
    setVoiceFornecedor('');
    setVoiceLinkedExpenseId('');
  }, []);

  const openVoiceModal = useCallback(() => {
    resetVoiceState();
    setVoiceModalOpen(true);
  }, [resetVoiceState]);

  const closeVoiceModal = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // no-op
    }
    setVoiceModalOpen(false);
    setVoiceListening(false);
    setVoiceFornecedor('');
    setVoiceLinkedExpenseId('');
  }, []);

  const clearVoiceTranscript = useCallback(() => {
    setVoiceTranscript('');
    setVoiceData(null);
    setVoiceFornecedor('');
    setVoiceLinkedExpenseId('');
    setVoiceError('');
  }, []);

  const saveVoiceExpense = useCallback(() => {
    if (!voiceData || !voiceData.valor) return;
    const data: ExpenseFormData = {
      tipoDespesa: voiceData.tipoDespesa,
      categoriaMaoDeObra: null,
      roomId: null,
      valor: voiceData.valor,
      quantidade: 1,
      titulo: voiceData.titulo || null,
      fornecedor: voiceFornecedor || null,
      formaPagamento: voiceData.formaPagamento,
      status: voiceData.status as 'PLANEJADO' | 'PAGO',
      dataPagamento: null,
      quantidadeParcela: null,
      dataInicioParcela: null,
      creditCardId: voiceData.creditCardId || null,
      bankAccountId: voiceData.bankAccountId || null,
      linkedExpenseId: voiceLinkedExpenseId || null,
    };
    if (voiceData.formaPagamento === PaymentForm.A_VISTA) {
      data.dataPagamento = voiceData.dataReferencia || toIsoDate(new Date());
    } else {
      data.quantidadeParcela = voiceData.quantidadeParcela || 1;
      data.dataInicioParcela = voiceData.dataReferencia || toIsoDate(new Date());
    }
    onCreate(data, () => {
      setVoiceModalOpen(false);
      setVoiceTranscript('');
      setVoiceData(null);
      setVoiceFornecedor('');
      setVoiceLinkedExpenseId('');
      setVoiceError('');
    });
  }, [onCreate, voiceData, voiceFornecedor, voiceLinkedExpenseId]);

  /** Projeto destino sugerido pela voz (objeto completo, se houver match). */
  const voiceLinkedProject = useMemo(() => {
    if (!voiceData?.linkedProjectId) return null;
    return projects?.find((p) => p.id === voiceData.linkedProjectId) ?? null;
  }, [projects, voiceData?.linkedProjectId]);

  return {
    voiceModalOpen,
    voiceSupported,
    voiceListening,
    voiceTranscript,
    voiceError,
    voiceData,
    setVoiceData,
    voiceFornecedor,
    setVoiceFornecedor,
    voiceLinkedExpenseId,
    setVoiceLinkedExpenseId,
    voiceLinkedProject,
    openVoiceModal,
    closeVoiceModal,
    clearVoiceTranscript,
    startVoiceCapture,
    saveVoiceExpense,
  };
}
