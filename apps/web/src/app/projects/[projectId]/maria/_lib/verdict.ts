/**
 * Veredito verde/vermelho para perguntas do tipo "posso gastar X?" (best-effort).
 * A resposta do agente é texto livre do LLM — não há JSON estruturado nem parsing
 * garantido do "cabe/não cabe". Por isso esta função só classifica quando a
 * pergunta do usuário é claramente do tipo "posso gastar" E a resposta do agente
 * começa com um sinal inequívoco (afirmação ou negação) nas primeiras palavras.
 * Fora esses dois casos, retorna `null` e o chamador deve renderizar a resposta
 * como bolha de texto simples (nunca forçar um card quebradiço sobre prosa livre).
 */

export type VerdictTone = 'good' | 'bad';

export interface Verdict {
  tone: VerdictTone;
}

const QUESTION_RE = /posso gastar|dá pra gastar|da pra gastar|consigo gastar|cabe gastar/i;

// Checadas nas primeiras ~6 palavras da resposta — evita capturar um "não" que
// apareça no meio de uma frase positiva (ex.: "Pode, mas não é ideal...").
const NEGATIVE_LEAD = /^(não|nao|infelizmente|melhor não)\b/i;
const POSITIVE_LEAD = /^(sim|pode|pode sim|cabe|dá|da|tranquilo)\b/i;

function leadingWords(text: string, count: number): string {
  return text.trim().split(/\s+/).slice(0, count).join(' ');
}

export function detectVerdict(userText: string, assistantText: string): Verdict | null {
  if (!QUESTION_RE.test(userText)) return null;

  const lead = leadingWords(assistantText, 6);
  if (NEGATIVE_LEAD.test(lead)) return { tone: 'bad' };
  if (POSITIVE_LEAD.test(lead)) return { tone: 'good' };
  return null;
}
