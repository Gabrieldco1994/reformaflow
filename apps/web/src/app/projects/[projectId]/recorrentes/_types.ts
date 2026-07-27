export interface RecurrenceSerie {
  /** Chave da série em base64url — vai na URL de PATCH/DELETE. */
  key: string;
  nome: string;
  tipoDespesa: string;
  tipoDespesaLabel: string;
  frequencia: string;
  diaVencimento: number;
  valorCents: number;
  ocorrencias: number;
  ocorrenciasPagas: number;
  ocorrenciasFuturas: number;
  primeiraData: string;
  ultimaData: string;
  proximaData: string | null;
  /** Série espelhada em outro projeto — editar aqui propaga lá. */
  temEspelho: boolean;
}
