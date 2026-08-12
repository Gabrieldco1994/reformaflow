import * as XLSX from 'xlsx';

/**
 * Corrige o range de uma planilha (`sheet['!ref']`) quando a tag `<dimension>`
 * do arquivo está DEFASADA (menor do que os dados realmente presentes).
 *
 * PORQUÊ ISTO EXISTE (causa-raiz de um incidente real):
 * `XLSX.utils.sheet_to_json({ header: 1 })` itera SOMENTE o range declarado em
 * `sheet['!ref']`, que o SheetJS lê da tag `<dimension ref="...">` do XML — ele
 * NÃO recalcula o range a partir das células. Alguns editores/ferramentas que
 * filtram e re-salvam um `.xlsx` deixam essa tag apontando para um range MENOR
 * do que o `<sheetData>` de fato contém. Resultado: `sheet_to_json` devolve só
 * as linhas até o limite declarado e TRUNCA todo o resto — um corte CONTÍGUO,
 * independente de valor/tipo. Foi assim que um extrato re-salvo perdeu tudo a
 * partir de 24/07 (inclusive um salário de R$9.990,28) enquanto o `.xls` bruto
 * original importava íntegro. O openpyxl, por recalcular o range a partir das
 * células, "via" as linhas — por isso a inspeção manual do arquivo não acusava
 * o problema, só a importação pelo SheetJS.
 *
 * As células fora do range declarado CONTINUAM presentes no objeto `sheet`
 * (o SheetJS lê todas as células do `<sheetData>`; só usa o `!ref` para
 * iterar). Então basta recalcular o range a partir dos endereços de célula
 * reais e nunca ENCOLHER o range declarado (união), que nenhuma linha é perdida.
 */
export function expandSheetRange(sheet: XLSX.WorkSheet): void {
  if (!sheet || typeof sheet !== 'object') return;

  const addrs = Object.keys(sheet).filter((k) => k[0] !== '!');
  if (!addrs.length) return;

  let minR = Infinity;
  let minC = Infinity;
  let maxR = -Infinity;
  let maxC = -Infinity;
  for (const a of addrs) {
    const cell = XLSX.utils.decode_cell(a);
    if (!cell || Number.isNaN(cell.r) || Number.isNaN(cell.c)) continue;
    if (cell.r < minR) minR = cell.r;
    if (cell.c < minC) minC = cell.c;
    if (cell.r > maxR) maxR = cell.r;
    if (cell.c > maxC) maxC = cell.c;
  }
  if (maxR === -Infinity) return;

  // União com o range declarado: nunca encolhe (um `!ref` maior que os dados é
  // inofensivo — vira linhas vazias que o parser já pula), só EXPANDE quando a
  // dimensão declarada está menor que os dados reais.
  const declared = sheet['!ref'] ? safeDecodeRange(sheet['!ref']) : null;
  if (declared) {
    minR = Math.min(minR, declared.s.r);
    minC = Math.min(minC, declared.s.c);
    maxR = Math.max(maxR, declared.e.r);
    maxC = Math.max(maxC, declared.e.c);
  }

  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
}

function safeDecodeRange(ref: string): XLSX.Range | null {
  try {
    return XLSX.utils.decode_range(ref);
  } catch {
    return null;
  }
}
