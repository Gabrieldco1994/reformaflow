/**
 * Ponte de "prompt pendente" da Maria: um passo do onboarding grava UMA
 * pergunta pré-formatada aqui e navega para a tela da Maria, que consome e
 * auto-envia na montagem. sessionStorage (não a URL) para não poluir o funil
 * do Clarity nem estourar a query string — mesmo espírito do pending-expense.ts.
 *
 * Consumo é destrutivo (remove ao ler): garante envio único e impede
 * re-disparo em refresh.
 */
const KEY = 'maria:pending-prompt';

export function setPendingMariaPrompt(prompt: string): void {
  const value = prompt.trim();
  if (!value) return;
  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    // ponytail: sessionStorage indisponível (SSR/private mode) — sem ponte, o
    // usuário ainda chega à Maria com input vazio. Degrada, não quebra.
  }
}

export function consumePendingMariaPrompt(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value) sessionStorage.removeItem(KEY);
    return value;
  } catch {
    return null;
  }
}
