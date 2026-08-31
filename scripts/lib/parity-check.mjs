// Lógica PURA de decisão do canário de paridade §10 (sem rede, sem process.exit).
// Consumida por scripts/validate-motores-prod.mjs e testada por parity-check.test.mjs.
//
// Contrato (issue #95): o canário faz 2 GETs autenticados com o MESMO Bearer:
//   /monthly → GET /projects/:id/monthly-overview          → body.caixa.hoje
//   /conta   → GET /projects/:id/monthly-overview/account-view → body.caixaHoje
// Paridade = os dois valores idênticos ao centavo. Cada caminho tem sua própria
// query Prisma / eleição de conta / filtro antes do kernel puro computeCaixaConta,
// então divergência = regressão de data-loading/filtro/âncora (classe #94/#508).

export const EXIT = {
  OK: 0, // paridade confirmada
  FIELD: 1, // campo ausente/não-numérico OU divergência §10
  HTTP: 2, // resposta fora de 2xx (não-401) / erro de transporte
  TOKEN: 3, // 401 — RF_TOKEN revogado, PO precisa rotacionar o secret
};

const TOKEN_HINTS = /Sess[aã]o encerrada|Sess[aã]o inv[aá]lida|Unauthorized/i;

export const brl = (cents) =>
  typeof cents === 'number' && Number.isFinite(cents)
    ? (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'n/d';

const asCents = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Aceita tanto o payload real quanto o número cru (conveniência de teste).
const extractMonthly = (m) =>
  asCents(m) ?? asCents(m?.caixa?.hoje);
const extractAccount = (a) =>
  asCents(a) ?? asCents(a?.caixaHoje);

/**
 * @param {{monthly?: unknown, account?: unknown, status?: number, body?: string}} input
 * @returns {{exitCode: number, ok: boolean, lines: string[], monthlyCents?: number, accountCents?: number}}
 */
export function checkParity(input = {}) {
  const lines = [];
  const done = (exitCode, ...msg) => ({
    exitCode,
    ok: exitCode === EXIT.OK,
    lines: [...lines, ...msg],
  });

  // Falha de transporte que se aplica ao run inteiro (uma das respostas != 2xx).
  if (typeof input.status === 'number' && (input.status < 200 || input.status >= 300)) {
    const body = String(input.body ?? '');
    if (input.status === 401 || TOKEN_HINTS.test(body)) {
      return done(
        EXIT.TOKEN,
        `✗ HTTP ${input.status} — token inválido/expirado. O PO precisa rotacionar o secret \`RF_TOKEN\` (bump de sessionVersion invalidou a sessão).`,
      );
    }
    return done(EXIT.HTTP, `✗ HTTP ${input.status} — resposta fora de 2xx da API de produção.`);
  }

  const monthlyCents = extractMonthly(input.monthly);
  const accountCents = extractAccount(input.account);

  if (monthlyCents === undefined || accountCents === undefined) {
    return done(
      EXIT.FIELD,
      `✗ campo ausente/não-numérico: /monthly caixa.hoje=${JSON.stringify(
        input.monthly?.caixa?.hoje ?? input.monthly,
      )} · /conta caixaHoje=${JSON.stringify(input.account?.caixaHoje ?? input.account)}`,
    );
  }

  const delta = accountCents - monthlyCents;
  if (delta !== 0) {
    return done(
      EXIT.FIELD,
      '✗ PARIDADE §10 FALHOU — os dois motores divergem:',
      `    /monthly (caixa.hoje) = ${monthlyCents} centavos  (${brl(monthlyCents)})`,
      `    /conta   (caixaHoje)  = ${accountCents} centavos  (${brl(accountCents)})`,
      `    Δ = ${delta} centavos (${brl(delta)})`,
      '    ⇒ regressão de data-loading / filtro / âncora de conta antes do kernel §10.',
    );
  }

  return {
    exitCode: EXIT.OK,
    ok: true,
    monthlyCents,
    accountCents,
    lines: [
      `✓ PARIDADE §10 OK — /monthly e /conta mostram ${monthlyCents} centavos (${brl(monthlyCents)}) para o PESSOAL.`,
    ],
  };
}
