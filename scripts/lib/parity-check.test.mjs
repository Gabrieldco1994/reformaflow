// Self-check da lógica pura do canário de paridade §10 (issue #95).
// Roda com: node --test scripts/lib/parity-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkParity, EXIT } from './parity-check.mjs';

test('paridade OK → exit 0', () => {
  const r = checkParity({ monthly: 105000, account: 105000 });
  assert.equal(r.exitCode, EXIT.OK);
  assert.equal(r.ok, true);
  assert.ok(r.lines.join('\n').includes('PARIDADE §10 OK'));
});

test('paridade OK com payloads reais → exit 0', () => {
  const r = checkParity({
    monthly: { caixa: { hoje: 6342735 } },
    account: { caixaHoje: 6342735 },
  });
  assert.equal(r.exitCode, EXIT.OK);
});

test('divergência de 1 centavo → exit 1 citando Δ e os dois valores', () => {
  const r = checkParity({ monthly: 105000, account: 104999 });
  assert.equal(r.exitCode, EXIT.FIELD);
  const out = r.lines.join('\n');
  assert.ok(out.includes('R$'));
  assert.ok(out.includes('0,01'));
  assert.ok(out.includes('105000'));
  assert.ok(out.includes('104999'));
});

test('campo ausente → exit 1 "campo ausente/não-numérico"', () => {
  const r = checkParity({ monthly: { caixa: {} }, account: {} });
  assert.equal(r.exitCode, EXIT.FIELD);
  assert.ok(r.lines.join('\n').includes('campo ausente/não-numérico'));
});

test('campo string (não-numérico) → exit 1', () => {
  const r = checkParity({ monthly: { caixa: { hoje: '105000' } }, account: { caixaHoje: 105000 } });
  assert.equal(r.exitCode, EXIT.FIELD);
  assert.ok(r.lines.join('\n').includes('campo ausente/não-numérico'));
});

test('401 → exit 3, instrução de rotação do RF_TOKEN', () => {
  const r = checkParity({ status: 401, body: 'Sessão encerrada' });
  assert.equal(r.exitCode, EXIT.TOKEN);
  assert.ok(r.lines.join('\n').includes('RF_TOKEN'));
});

test('não-2xx não-401 → exit 2', () => {
  const r = checkParity({ status: 404, body: 'Not Found' });
  assert.equal(r.exitCode, EXIT.HTTP);
});
