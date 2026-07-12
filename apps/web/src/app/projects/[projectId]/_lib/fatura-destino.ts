/**
 * Determina a fatura de destino para compras no cartão.
 * Regra: dia da compra >= closingDay cai na fatura do mês seguinte.
 */
export interface FaturaDestino {
  fecha: string;
  vence: string;
  mesLabel: string;
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'] as const;

export function faturaDestino(
  dataCompra: Date,
  closingDay: number | null,
  dueDay: number | null,
): FaturaDestino | null {
  if (closingDay == null) return null;

  // Datas ISO "yyyy-mm-dd" parseiam como UTC-meia-noite; usar getters UTC evita
  // que um fuso negativo (ex.: America/Sao_Paulo) "volte" um dia na leitura.
  const compraAno = dataCompra.getUTCFullYear();
  const compraMes = dataCompra.getUTCMonth();
  const compraDia = dataCompra.getUTCDate();

  let alvoAno = compraAno;
  let alvoMes = compraMes;
  if (compraDia >= closingDay) {
    alvoMes += 1;
    if (alvoMes > 11) {
      alvoMes = 0;
      alvoAno += 1;
    }
  }

  const fecha = `${closingDay} ${MESES[alvoMes]}`;
  const vence = dueDay == null ? '—' : `${dueDay} ${MESES[alvoMes]}`;
  const mesLabel = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(alvoAno, alvoMes, 1)));

  return { fecha, vence, mesLabel };
}
