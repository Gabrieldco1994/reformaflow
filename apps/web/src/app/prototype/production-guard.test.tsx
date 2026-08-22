import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AgentMonitorPage from './agent-monitor/page';
import PrototypeKpiPage from './kpi/page';

/**
 * Toda rota sob `/prototype` tem de sumir em produção.
 *
 * "Não linkado" não é "não publicado". O App Router serve qualquer diretório
 * com `page.tsx`, então uma tela de protótipo sem entrada de menu, sem link e
 * com ZERO referências em `apps/web/src` continua respondendo 200 para quem
 * digitar a URL. Foi o caso de `/prototype/kpi`, que estava no ar.
 *
 * Os dois diretórios de prototype são ferramenta de trabalho do time; o guard
 * esconde a ROTA em produção, não apaga a ferramenta.
 */

const NOT_FOUND = 'NEXT_NOT_FOUND';

// O `notFound()` de verdade INTERROMPE o render lançando — não retorna. Um mock
// que só registrasse a chamada deixaria o componente seguir para o JSX, e o
// teste mediria uma coisa diferente da que acontece em produção.
const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error(NOT_FOUND);
  }),
}));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

/**
 * Os imports são estáticos e no topo DE PROPÓSITO: o runtime de JSX que o Vite
 * escolhe (`react/jsx-dev-runtime`) é resolvido na carga do módulo, e carregar
 * a página já com `NODE_ENV=production` entrega um runtime sem `jsxDEV` — o
 * teste falharia pelo motivo errado, e não por falta de guard.
 */
const ROTAS: Record<string, () => unknown> = {
  'agent-monitor': AgentMonitorPage,
  kpi: PrototypeKpiPage,
};

describe('rotas de protótipo não existem em produção', () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    vi.unstubAllEnvs();
  });

  /**
   * A lista acima é escrita à mão, então precisa de quem cobre por ela: este
   * caso varre o diretório e falha quando aparece um protótipo sem caso de
   * teste. Sem ele, o próximo protótipo entra sem guard e sem ninguém notar —
   * que é exatamente como `/prototype/kpi` foi parar em produção.
   */
  it('todo diretório de protótipo tem um caso aqui', () => {
    // `process.cwd()` é `apps/web` (onde mora o vitest.config). `import.meta.url`
    // não serve: sob o transform do Vite ele não é uma URL `file:`.
    const raiz = join(process.cwd(), 'src/app/prototype');
    expect(existsSync(raiz), `diretório de protótipos não encontrado em ${raiz}`).toBe(true);

    const encontradas = readdirSync(raiz, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(raiz, e.name, 'page.tsx')))
      .map((e) => e.name)
      .sort();

    expect(encontradas).toEqual(Object.keys(ROTAS).sort());
  });

  for (const [slug, Page] of Object.entries(ROTAS)) {
    it(`/prototype/${slug} responde em dev e 404 em produção`, () => {
      expect(Page()).toBeTruthy();
      expect(notFoundMock).not.toHaveBeenCalled();

      // O guard lê `process.env.NODE_ENV` na chamada, então trocar agora basta.
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => Page()).toThrow(NOT_FOUND);
      expect(notFoundMock).toHaveBeenCalled();
    });
  }
});
