/**
 * Censo de nomes acessíveis — enxerga o que a leitura do arquivo não enxerga.
 *
 * CTA duplicada é invisível para quem rola a tela (as duas ocorrências ficam
 * longe uma da outra, às vezes em componentes diferentes) e óbvia para quem
 * COLETA e CONTA. Por isso auditoria de rótulo aqui não usa `getByRole(…, name)`
 * um por um: a query acha o botão que você JÁ SABE que existe; o censo acha o
 * que você não sabia.
 *
 * O nome é a aproximação honesta do que o leitor de tela anuncia para os
 * controles deste app: `aria-label` quando existe, senão o texto visível
 * (ícones são `<svg>` sem texto, então não sujam o resultado). Não é o
 * `computeAccessibleName` completo de propósito — `dom-accessibility-api` é
 * dependência transitiva do testing-library, não nossa, e importá-la direto
 * seria dependência fantasma.
 *
 * ATENÇÃO ao escopo: em jsdom não existe layout, então `hidden md:flex`
 * continua no DOM. Propriedade que depende de VIEWPORT tem de ser medida no
 * Playwright — aqui um censo de página inteira mistura desktop com mobile e
 * acusa duplicata que o usuário nunca vê. Use `root` para recortar a região que
 * é a mesma nos dois viewports, ou meça no navegador.
 */

/** Nome anunciado de um controle: `aria-label` ganha do texto visível. */
export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Só os nomes que colidem, sem repetir o relatório.
 *
 * `filter((n, i) => list.indexOf(n) !== i)` devolve a 2ª, 3ª… ocorrência; o
 * `Set` colapsa para "quais rótulos colidem", que é a pergunta.
 */
export function duplicates(names: string[]): string[] {
  return [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
}

/** Censo de nomes dos controles casados por `selector` dentro de `root`. */
export function nameCensus(root: ParentNode, selector = 'button, a[href]'): string[] {
  return [...root.querySelectorAll(selector)].map(accessibleName).filter(Boolean);
}
