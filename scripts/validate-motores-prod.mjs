#!/usr/bin/env node
/**
 * Validação READ-ONLY dos motores de "caixa/saldo" em PRODUÇÃO — Fase E (§10).
 *
 * Molde: AUDITORIA-MOTORES-PROD.md. Este script SÓ FAZ GET; nunca escreve em prod,
 * nunca toca /data/dev.db. Confirma a INVARIANTE de PARIDADE: os motores que
 * alimentam as quatro telas devolvem o MESMO número de caixa para o PESSOAL.
 *
 *   /monthly    ← GET /projects/:id/monthly-overview            → caixa.hoje      (§10 método privado)
 *   /conta      ← GET /projects/:id/monthly-overview/account-view→ caixaHoje      (§10 inline)
 *   /cash-flow  ← idem account-view (headline PESSOAL lê o §10)  → caixaHoje
 *   /financeiro ← GET /tenant/financial/overview                → caixaTotal      (§10 via getCaixaConta)
 *
 * Todos os campos estão em CENTAVOS. A prova forte é que os DOIS caminhos do §10
 * (método privado × inline do account-view) coincidem sobre os dados vivos.
 *
 * Uso:
 *   RF_TOKEN=<jwt> node scripts/validate-motores-prod.mjs
 * Opcionais:
 *   RF_API=https://reformaflow-api.fly.dev   (base da API)
 *   RF_PROJECT=cmphg0sj5004gu81jkeqt2s00     (id do projeto PESSOAL)
 *   RF_MONTH=2026-07                          (mês; caixaHoje independe do mês)
 *   RF_EXPECT_CENTS=6342735                   (fixa o snapshot: R$ 63.427,35 = 6342735)
 *
 * Sai com código 1 se a paridade falhar (serve de gate).
 */

const API = (process.env.RF_API || 'https://reformaflow-api.fly.dev').replace(/\/$/, '');
const TOKEN = process.env.RF_TOKEN;
const PROJECT = process.env.RF_PROJECT || 'cmphg0sj5004gu81jkeqt2s00';
const MONTH = process.env.RF_MONTH || '';
const EXPECT = process.env.RF_EXPECT_CENTS ? Number(process.env.RF_EXPECT_CENTS) : null;

if (!TOKEN) {
  console.error('✗ Falta RF_TOKEN (JWT do usuário). Ex.: RF_TOKEN=eyJ... node scripts/validate-motores-prod.mjs');
  process.exit(2);
}

const brl = (cents) =>
  typeof cents === 'number' && Number.isFinite(cents)
    ? (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    : 'n/d';

/** ÚNICO ponto de rede — hardcoded GET, read-only por construção. */
async function get(path) {
  const res = await fetch(`${API}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

const q = MONTH ? `?month=${encodeURIComponent(MONTH)}` : '';

async function main() {
  console.log(`\n🔎 Validação READ-ONLY dos motores — ${API}`);
  console.log(`   Projeto PESSOAL: ${PROJECT}${MONTH ? `  (mês ${MONTH})` : ''}\n`);

  const [monthly, accountView, tenant, cashflow] = await Promise.all([
    get(`/projects/${PROJECT}/monthly-overview${q}`),
    get(`/projects/${PROJECT}/monthly-overview/account-view${q}`),
    get(`/tenant/financial/overview`),
    get(`/projects/${PROJECT}/cash-flow`),
  ]);

  const s10Monthly = monthly?.caixa?.hoje ?? null; // /monthly  (§10 privado)
  const s10Account = accountView?.caixaHoje ?? null; // /conta, /cash-flow (§10 inline)
  const tf = tenant?.caixaTotal ?? null; // /financeiro (§10 via getCaixaConta)
  const cfLast = Array.isArray(cashflow) && cashflow.length ? cashflow[cashflow.length - 1] : null;
  const cfRolling = cfLast?.rollingBalance ?? null; // referência (orçamentário, desde zero)
  const cfRealizado = cfLast?.rollingBalanceRealizado ?? null;

  const rows = [
    ['/monthly     · monthly-overview.caixa.hoje', s10Monthly, '§10 (método privado)'],
    ['/conta       · account-view.caixaHoje', s10Account, '§10 (inline)'],
    ['/cash-flow   · account-view.caixaHoje (headline)', s10Account, '§10 (mesma fonte de /conta)'],
    ['/financeiro  · tenant-financial.caixaTotal', tf, '§10 (getCaixaConta)'],
  ];
  console.log('  ┌─ CAIXA por tela ────────────────────────────────────────────────');
  for (const [label, val, src] of rows) {
    console.log(`  │ ${label.padEnd(48)} ${brl(val).padStart(16)}   ${src}`);
  }
  console.log('  ├─ Referência (não é saldo bancário) ─────────────────────────────');
  console.log(`  │ ${'cash-flow rolling (orçamentário, desde zero)'.padEnd(48)} ${brl(cfRolling).padStart(16)}`);
  console.log(`  │ ${'cash-flow realizado (orçamentário)'.padEnd(48)} ${brl(cfRealizado).padStart(16)}`);
  console.log('  └─────────────────────────────────────────────────────────────────\n');

  // ── Paridade §10: os três consumidores têm de coincidir ──
  const canon = [s10Monthly, s10Account, tf];
  const allNumbers = canon.every((v) => typeof v === 'number' && Number.isFinite(v));
  const allEqual = allNumbers && canon.every((v) => v === s10Monthly);

  let ok = true;

  if (!allNumbers) {
    ok = false;
    console.log('✗ PARIDADE: algum motor não devolveu número (tenant sem PESSOAL? sem permissão financialDashboard?).');
  } else if (!allEqual) {
    ok = false;
    console.log('✗ PARIDADE FALHOU — os motores do §10 divergem entre si:');
    console.log(`    /monthly    = ${brl(s10Monthly)}`);
    console.log(`    /conta      = ${brl(s10Account)}   (Δ vs /monthly = ${brl(s10Account - s10Monthly)})`);
    console.log(`    /financeiro = ${brl(tf)}   (Δ vs /monthly = ${brl(tf - s10Monthly)})`);
    console.log('    ⇒ investigar: dual-path §10 (privado × inline) ou tenant-financial fora do §10.');
  } else {
    console.log(`✓ PARIDADE §10 OK — as quatro telas mostram ${brl(s10Monthly)} para o PESSOAL.`);
  }

  // ── Pin opcional do snapshot congelado ──
  if (EXPECT != null) {
    if (s10Account === EXPECT) {
      console.log(`✓ SNAPSHOT OK — §10 == ${brl(EXPECT)} (valor congelado).`);
    } else {
      ok = false;
      console.log(`✗ SNAPSHOT — §10 = ${brl(s10Account)} ≠ esperado ${brl(EXPECT)} (Δ ${brl(s10Account - EXPECT)}).`);
      console.log('    (Dados vivos mudam com o tempo — só falhe aqui se estiver conferindo o dia do snapshot.)');
    }
  }

  // ── Referência informativa do cash-flow (não é gate) ──
  if (typeof cfRolling === 'number' && typeof s10Account === 'number' && cfRolling !== s10Account) {
    console.log(
      `\nℹ️  cash-flow rolling (${brl(cfRolling)}) difere do §10 (${brl(s10Account)}) por ${brl(cfRolling - s10Account)} — ` +
        'esperado: é fluxo orçamentário desde zero. A tela /cash-flow mostra o §10 no headline.',
    );
  }

  console.log('');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n✗ Erro na validação: ${err.message}\n`);
  process.exit(2);
});
