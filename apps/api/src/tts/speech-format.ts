/**
 * Utilidades de formatação de TEXTO PARA FALA (TTS).
 *
 * O VibeVoice lê melhor texto "verbalizado": números de moeda viram extenso
 * (incluindo centavos) e emojis são removidos. Isto NÃO afeta o texto exibido
 * no chat — só o que é enviado ao sintetizador.
 */

const UNIDADES = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const DEZ_A_DEZENOVE = [
  'dez', 'onze', 'doze', 'treze', 'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove',
];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = [
  '', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos',
];
const ESCALAS: ReadonlyArray<readonly [string, string]> = [
  ['', ''],
  ['mil', 'mil'],
  ['milhão', 'milhões'],
  ['bilhão', 'bilhões'],
  ['trilhão', 'trilhões'],
];

/** Converte um inteiro 0..999 em extenso (sem escala). */
function ate999(n: number): string {
  if (n <= 0) return '';
  if (n === 100) return 'cem';
  const centena = Math.floor(n / 100);
  const resto = n % 100;
  const parts: string[] = [];
  if (centena > 0) parts.push(CENTENAS[centena]!);
  if (resto > 0) {
    if (resto < 10) parts.push(UNIDADES[resto]!);
    else if (resto < 20) parts.push(DEZ_A_DEZENOVE[resto - 10]!);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      parts.push(u === 0 ? DEZENAS[d]! : `${DEZENAS[d]} e ${UNIDADES[u]}`);
    }
  }
  return parts.join(' e ');
}

/** Converte um inteiro não-negativo em extenso (pt-BR). */
export function intToExtenso(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  const n = Math.floor(value);
  if (n === 0) return 'zero';

  const groups: number[] = [];
  let x = n;
  while (x > 0) {
    groups.push(x % 1000);
    x = Math.floor(x / 1000);
  }

  const segments: { text: string; value: number }[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g === 0) continue;
    let text: string;
    if (i === 1 && g === 1) {
      text = 'mil';
    } else {
      const [singular, plural] = ESCALAS[i] ?? ['', ''];
      const scale = i === 0 ? '' : g === 1 ? singular : plural;
      text = scale ? `${ate999(g)} ${scale}` : ate999(g);
    }
    segments.push({ text, value: g });
  }

  let out = segments[0]!.text;
  for (let k = 1; k < segments.length; k++) {
    const seg = segments[k]!;
    const sep = seg.value < 100 || seg.value % 100 === 0 ? ' e ' : ' ';
    out += sep + seg.text;
  }
  return out;
}

/** Verbaliza um valor (reais + centavos) com plural/singular corretos. */
export function valorToExtenso(reais: number, centavos: number): string {
  const r = Math.max(0, Math.floor(reais));
  const c = Math.max(0, Math.min(99, Math.floor(centavos)));
  const parts: string[] = [];
  if (r > 0) parts.push(`${intToExtenso(r)} ${r === 1 ? 'real' : 'reais'}`);
  if (c > 0) parts.push(`${intToExtenso(c)} ${c === 1 ? 'centavo' : 'centavos'}`);
  if (parts.length === 0) return 'zero reais';
  return parts.join(' e ');
}

/**
 * Substitui ocorrências de moeda ("R$ 1.234,56") pelo valor por extenso,
 * para o TTS ler centavos corretamente. Mantém o restante do texto intacto.
 */
export function verbalizeCurrency(text: string): string {
  return text.replace(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/g, (match, intPart: string, dec?: string) => {
    const reais = Number.parseInt(intPart.replace(/\./g, ''), 10);
    if (Number.isNaN(reais)) return match;
    const centavos = dec ? Number.parseInt(dec.padEnd(2, '0'), 10) : 0;
    return valorToExtenso(reais, centavos);
  });
}

/** Remove emojis, emoticons pictográficos e seletores de variação. */
export function stripEmoji(text: string): string {
  return text
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // bandeiras (indicadores regionais)
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '') // modificadores de tom de pele
    .replace(/\p{Extended_Pictographic}/gu, '') // emojis pictográficos
    .replace(/[\u200D\uFE0E\uFE0F]/gu, '') // ZWJ + seletores de variação
    .replace(/[ \t]{2,}/g, ' ');
}
