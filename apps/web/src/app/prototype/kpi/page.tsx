/**
 * Página de validação visual — Fase A Design System
 * Mostra todas as variantes de KpiTile lado a lado para aceite visual em 360px e desktop.
 */

'use client';

import { KpiTile } from '@/components/KpiTile';
import { Delta } from '@/components/Delta';
import { moneyGlance, moneyDetail } from '@/lib/money';

export default function PrototypeKpiPage() {
  const exampleCents = 645000; // R$ 6.450
  const negativeCents = -192000; // -R$ 1.920
  const smallCents = 98500; // R$ 985

  return (
    <div className="bg-lifeone-bg min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold mb-2">Fase A — Design System Validation</h1>
        <p className="text-lifeone-ink-3 mb-8">
          Validação visual em 360px (mobile) e desktop. Sem truncamento, piso tipográfico ≥11px.
        </p>

        {/* SEÇÃO: Variantes Hero */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">Hero Variants</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <KpiTile
              label="Caixa hoje"
              value={moneyGlance(exampleCents)}
              variant="hero"
              tone="positive"
              context="Faltam R$ 8,3 mil até o fim do mês"
            />
            <KpiTile
              label="Saldo projetado"
              value={moneyGlance(negativeCents)}
              variant="hero"
              tone="negative"
              context="Sem novos lançamentos"
            />
            <KpiTile
              label="Limite de crédito"
              value={moneyGlance(exampleCents)}
              variant="hero"
              tone="accent"
              context="R$ 10.000 disponíveis"
            />
          </div>
        </section>

        {/* SEÇÃO: Variantes Support */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">Support Variants (Compact)</h2>
          <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
            <KpiTile
              label="No cartão"
              value={moneyGlance(128000)}
              variant="support"
              tone="neutral"
            />
            <KpiTile
              label="À vista"
              value={moneyGlance(32000)}
              variant="support"
              tone="neutral"
            />
            <KpiTile
              label="Melhorou vs mês"
              value="24%"
              variant="support"
              tone="positive"
            />
            <KpiTile
              label="Meta estourada"
              value={moneyGlance(negativeCents)}
              variant="support"
              tone="negative"
            />
          </div>
        </section>

        {/* SEÇÃO: State/Tinted (com tom semântico) */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">State/Tinted Variants</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <KpiTile
              label="Positivo"
              value={moneyGlance(exampleCents)}
              variant="state"
              tone="positive"
              context="Resultado do mês acima da meta"
            />
            <KpiTile
              label="Negativo"
              value={moneyGlance(negativeCents)}
              variant="state"
              tone="negative"
              context="Caixa insuficiente para próximas saídas"
            />
            <KpiTile
              label="Aviso"
              value={moneyGlance(exampleCents)}
              variant="state"
              tone="warning"
              context="Fatura vence em 3 dias"
            />
            <KpiTile
              label="Neutro"
              value={moneyGlance(smallCents)}
              variant="state"
              tone="neutral"
              context="Transação padrão do mês"
            />
          </div>
        </section>

        {/* SEÇÃO: Com InfoHint e contexto extra */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">Com Info Hint & Extra</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <KpiTile
              label="Projeção de saldo"
              value={moneyGlance(exampleCents)}
              variant="hero"
              tone="positive"
              info="Baseado no fluxo de caixa previsível do mês"
              context="Sem novos lançamentos"
              extra={
                <div className="mt-3 text-sm text-lifeone-ink-2">
                  <Delta value={57000} type="cents" isGood={true} />
                </div>
              }
            />
            <KpiTile
              label="Resultado mensal"
              value={moneyDetail(645043)}
              variant="plain"
              tone="positive"
              info="Competência: renda - despesas"
              context="Com impostos e previsões"
            />
          </div>
        </section>

        {/* SEÇÃO: Clickable (quick-filter) */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">Clickable / Filter Toggle</h2>
          <div className="grid gap-2 md:grid-cols-4">
            <KpiTile
              label="Todos"
              value="—"
              onClick={() => console.log('filter: all')}
              active
              variant="support"
            />
            <KpiTile
              label="Cartão"
              value="4 items"
              onClick={() => console.log('filter: card')}
              variant="support"
            />
            <KpiTile
              label="À vista"
              value="2 items"
              onClick={() => console.log('filter: cash')}
              variant="support"
            />
            <KpiTile
              label="Planejado"
              value="3 items"
              onClick={() => console.log('filter: scheduled')}
              variant="support"
            />
          </div>
        </section>

        {/* SEÇÃO: Detalhes de responsividade */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">Responsiveness Check</h2>
          <div className="bg-white border border-lifeone-line rounded-lg p-4 text-sm text-lifeone-ink-3">
            <p>
              ✓ Este wireframe deve renderizar sem truncamento horizontal em 360px (mobile)
            </p>
            <p>
              ✓ Piso tipográfico: labels ≥11px, valores de lista ≥15px, herói ≥26px
            </p>
            <p>
              ✓ Espaçamento em grade de 8pt (cards p-3 = 12px, gap-4 = 16px)
            </p>
            <p>
              ✓ Cores semânticas (positive/negative/warning/neutral/accent) aplicadas
              consistentemente
            </p>
          </div>
        </section>

        {/* SEÇÃO: Testbed Delta */}
        <section className="mb-12">
          <h2 className="text-lg font-bold mb-4 text-lifeone-ink">Delta Component</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="bg-white border border-lifeone-line rounded-lg p-4">
              <p className="text-sm text-lifeone-ink-3 mb-2">Melhora (isGood=true)</p>
              <Delta value={57000} type="cents" isGood={true} />
            </div>
            <div className="bg-white border border-lifeone-line rounded-lg p-4">
              <p className="text-sm text-lifeone-ink-3 mb-2">Piora (isGood=true)</p>
              <Delta value={-32000} type="cents" isGood={true} />
            </div>
            <div className="bg-white border border-lifeone-line rounded-lg p-4">
              <p className="text-sm text-lifeone-ink-3 mb-2">Redução de custo (isGood=false)</p>
              <Delta value={-15000} type="cents" isGood={false} />
            </div>
            <div className="bg-white border border-lifeone-line rounded-lg p-4">
              <p className="text-sm text-lifeone-ink-3 mb-2">Crescimento % (percent)</p>
              <Delta value={24} type="percent" isGood={true} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
