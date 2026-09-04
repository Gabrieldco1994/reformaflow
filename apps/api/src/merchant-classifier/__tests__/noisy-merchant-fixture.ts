/**
 * Fixture de merchants "ruidosos" de extrato/fatura reais (Itaú / Nubank / C6),
 * entregue pelo ai-quality para o teste de taxa-de-falso-reject do #582 reopen.
 *
 * `echoByNameAligns`: `normalizeKey(resolvedMerchant) === normalizeKey(raw)` — i.e.
 * o mecanismo ANTIGO (eco-de-nome) teria alinhado. Quase todo o fixture é `false`:
 * é exatamente o cenário que quebrava o alinhamento por nome e motivou a troca
 * para índice 1-based explícito.
 */
export interface NoisyMerchantCase {
  raw: string;
  normalizedKey: string;
  resolvedMerchant: string;
  expectedCategory: string;
  echoByNameAligns: boolean;
}

export const NOISY_MERCHANT_FIXTURE: readonly NoisyMerchantCase[] = [
  { raw: 'PAY IFD 12/03',                    normalizedKey: 'pay ifd',                      resolvedMerchant: 'iFood',                       expectedCategory: 'alimentação',   echoByNameAligns: false },
  { raw: 'PIX QRS ENEL DISTRIB SP 03/2026',  normalizedKey: 'pix qrs enel distrib sp 03',   resolvedMerchant: 'Enel',                        expectedCategory: 'moradia',       echoByNameAligns: false },
  { raw: 'UBER* TRIP HELP.UBER.COM',         normalizedKey: 'uber trip help uber',          resolvedMerchant: 'Uber',                        expectedCategory: 'transporte',    echoByNameAligns: false },
  { raw: 'MERCADOLIVRE*2 PARCELA',           normalizedKey: 'mercadolivre 2 parcela',       resolvedMerchant: 'Mercado Livre',               expectedCategory: 'compras',       echoByNameAligns: false },
  { raw: 'TED 12345 MARIA S OLIVEIRA',       normalizedKey: 'ted maria s oliveira',         resolvedMerchant: 'Maria S Oliveira',            expectedCategory: 'transferência', echoByNameAligns: false },
  { raw: 'IFOOD *IFD BR',                    normalizedKey: 'ifood ifd br',                 resolvedMerchant: 'iFood',                       expectedCategory: 'alimentação',   echoByNameAligns: false },
  { raw: 'PIX TRANSF JOAO S 15/02',          normalizedKey: 'pix transf joao s',            resolvedMerchant: 'João S',                      expectedCategory: 'transferência', echoByNameAligns: false },
  { raw: 'PAG*99APP SAO PAULO',              normalizedKey: 'pag 99app sao paulo',          resolvedMerchant: '99',                          expectedCategory: 'transporte',    echoByNameAligns: false },
  { raw: 'NETFLIX.COM 4155 SAO PAULO',       normalizedKey: 'netflix sao paulo',            resolvedMerchant: 'Netflix',                     expectedCategory: 'assinaturas',   echoByNameAligns: false },
  { raw: 'DROGARIA SAO PAULO LTDA 07/03',    normalizedKey: 'drogaria sao paulo',           resolvedMerchant: 'Drogaria São Paulo',          expectedCategory: 'saúde',         echoByNameAligns: true  },
  { raw: 'SPOTIFY P3A4B5C6',                 normalizedKey: 'spotify p3a4b5c6',             resolvedMerchant: 'Spotify',                     expectedCategory: 'assinaturas',   echoByNameAligns: false },
  { raw: 'POSTO IPIRANGA 24H',               normalizedKey: 'posto ipiranga 24h',           resolvedMerchant: 'Posto Ipiranga',              expectedCategory: 'transporte',    echoByNameAligns: false },
  { raw: 'AMAZON BR SERVICOS DE VAR',        normalizedKey: 'amazon br servicos de var',    resolvedMerchant: 'Amazon',                      expectedCategory: 'compras',       echoByNameAligns: false },
  { raw: 'SISPAG SABESP 03/03',              normalizedKey: 'sispag sabesp',                resolvedMerchant: 'Sabesp',                      expectedCategory: 'moradia',       echoByNameAligns: false },
  { raw: 'PIX QRS 99 TECNOLOGIA LTDA',       normalizedKey: 'pix qrs 99 tecnologia',        resolvedMerchant: '99',                          expectedCategory: 'transporte',    echoByNameAligns: false },
  { raw: 'RECARGA CELULAR TIM 5561',         normalizedKey: 'recarga celular tim',          resolvedMerchant: 'TIM',                         expectedCategory: 'servicos',      echoByNameAligns: false },
  { raw: 'LOJA RENNER 0518 SP',              normalizedKey: 'renner sp',                    resolvedMerchant: 'Renner',                      expectedCategory: 'compras',       echoByNameAligns: false },
  { raw: 'MP *MERCADOPAGO 11/02',            normalizedKey: 'mp mercadopago',               resolvedMerchant: 'Mercado Pago',                expectedCategory: 'compras',       echoByNameAligns: false },
  { raw: 'C6 BANK PAGAMENTO FATURA',         normalizedKey: 'c6 bank pagamento fatura',     resolvedMerchant: 'C6 Bank',                     expectedCategory: 'transferência', echoByNameAligns: false },
  { raw: 'ESTACIONAMENTO S/A 22/02',         normalizedKey: 'estacionamento s a',           resolvedMerchant: 'Estacionamento',              expectedCategory: 'transporte',    echoByNameAligns: false },
  { raw: 'SUPERMERCADO PAO DE ACUCAR',       normalizedKey: 'supermercado pao de acucar',   resolvedMerchant: 'Supermercado Pão de Açúcar',  expectedCategory: 'alimentação',   echoByNameAligns: true  },
  { raw: 'PADARIA E CONFEITARIA REAL',       normalizedKey: 'padaria e confeitaria real',   resolvedMerchant: 'Padaria e Confeitaria Real',  expectedCategory: 'alimentação',   echoByNameAligns: true  },
] as const;

/** Categorias que o F1 de `classifyForImport` remove (mapeiam p/ ExpenseType.OUTROS). */
export const F1_DROPPED_CATEGORIES = ['compras', 'servicos', 'impostos', 'investimentos', 'outros'];
