#!/usr/bin/env node
/**
 * Canário READ-ONLY da invariante de PARIDADE do caixa §10 em PRODUÇÃO (issue #95).
 *
 * SÓ FAZ GET; nunca escreve em prod, nunca toca /data/dev.db. Confirma que os DOIS
 * motores que renderizam o headline de caixa do PESSOAL devolvem o MESMO número:
 *
 *   /monthly  ← GET /projects/:id/monthly-overview              → body.caixa.hoje  (§10 via getCaixaConta → computeCaixaConta)
 *   /conta    ← GET /projects/:id/monthly-overview/account-view → body.caixaHoje   (§10 inline via computeAccountView)
 *
 * Ambos convergem para a função pura computeCaixaConta (kernel compartilhado, #508),
 * MAS cada caminho faz sua própria query Prisma, eleição de conta primária e filtro
 * de bankExpenses/bankReceipts ANTES do kernel — divergência = regressão de
 * data-loading/filtro/âncora (classe #94/#508). Não é `x === x`.
 *
 * Campos em CENTAVOS. `month` não afeta o headline (saldo pontual de hoje, corte em
 * FINANCIAL_TIME_ZONE server-side) — RF_MONTH é opcional e, se passado, vai igual aos 2 GETs.
 *
 * Uso:
 *   RF_TOKEN=<jwt> node scripts/validate-motores-prod.mjs
 * Opcionais:
 *   RF_API=https://reformaflow-api.fly.dev   (base da API)
 *   RF_PROJECT=cmphg0sj5004gu81jkeqt2s00     (id do projeto PESSOAL)
 *   RF_MONTH=2026-07                          (mês; o headline independe do mês)
 *
 * Exit codes: 0 paridade OK · 1 campo ausente/divergência · 2 HTTP não-2xx / RF_TOKEN ausente
 *             3 401 (RF_TOKEN revogado — PO rotaciona o secret).
 */
import { checkParity, brl, EXIT } from './lib/parity-check.mjs';

const API = (process.env.RF_API || 'https://reformaflow-api.fly.dev').replace(/\/$/, '');
const TOKEN = process.env.RF_TOKEN;
const PROJECT = process.env.RF_PROJECT || 'cmphg0sj5004gu81jkeqt2s00';
const MONTH = process.env.RF_MONTH || '';

if (!TOKEN) {
  console.error('✗ Falta RF_TOKEN (JWT do usuário). Ex.: RF_TOKEN=eyJ... node scripts/validate-motores-prod.mjs');
  process.exit(EXIT.HTTP); // 2
}

const q = MONTH ? `?month=${encodeURIComponent(MONTH)}` : '';

/**
 * ÚNICO ponto de rede — method:'GET' hardcoded, read-only por construção.
 * NUNCA logar TOKEN nem headers. No path de erro só o status + mensagem fixa.
 */
async function get(path) {
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: body.slice(0, 200) };
  }
  return { ok: true, json: await res.json() };
}

async function main() {
  console.log(`\n🔎 Canário de paridade §10 (READ-ONLY) — ${API}`);
  console.log(`   Projeto PESSOAL: ${PROJECT}${MONTH ? `  (mês ${MONTH})` : ''}\n`);

  const [monthly, account] = await Promise.all([
    get(`/projects/${PROJECT}/monthly-overview${q}`),
    get(`/projects/${PROJECT}/monthly-overview/account-view${q}`),
  ]);

  const bad = [monthly, account].find((r) => !r.ok);
  const result = bad
    ? checkParity({ status: bad.status, body: bad.body })
    : checkParity({ monthly: monthly.json, account: account.json });

  if (result.ok) {
    console.log('  ┌─ CAIXA §10 por tela ────────────────────────────────');
    console.log(`  │ /monthly · caixa.hoje  ${String(result.monthlyCents).padStart(12)}  ${brl(result.monthlyCents)}`);
    console.log(`  │ /conta   · caixaHoje   ${String(result.accountCents).padStart(12)}  ${brl(result.accountCents)}`);
    console.log('  └────────────────────────────────────────────────────');
  }
  console.log('');
  for (const line of result.lines) console.log(line);
  console.log('');
  process.exit(result.exitCode);
}

main().catch((err) => {
  console.error(`\n✗ Erro na validação: ${err.message}\n`);
  process.exit(EXIT.HTTP); // 2
});
