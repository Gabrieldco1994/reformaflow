import { test, expect } from '@playwright/test';

/**
 * #639 — o layout raiz montava <SpeedInsights /> incondicionalmente. Em
 * `next build && next start` local (fora da Vercel), `NODE_ENV=production`
 * (igual à Vercel) mas NÃO existe edge da Vercel para servir
 * `/_vercel/speed-insights/script.js` -> 404 previsível em toda navegação.
 *
 * `next dev` NÃO reproduz o bug (NODE_ENV=development faz o pacote usar um
 * script hospedado externamente) — por isso este spec roda contra um build de
 * produção próprio (`playwright.speed-insights.config.ts`), não contra o
 * `playwright.config.ts` padrão.
 *
 * A variável `VERCEL` (setada pela plataforma em build e runtime, distinta de
 * `NODE_ENV`) decide qual branch deste teste roda: sem ela, provamos que o
 * runtime local não solicita o script; com `VERCEL=1`, provamos que a
 * telemetria continua montada (a integração real da Vercel, fora deste
 * harness, é quem de fato serve o script e recebe os vitals).
 *
 * IMPORTANTE (build-time, não só runtime): `/login` é prerenderizada como
 * página estática (`○` no output do `next build`), então o layout raiz é
 * avaliado durante o BUILD, não a cada request — `VERCEL` precisa estar
 * setada já no `next build`, não só no `next start`, para o branch "na
 * Vercel" fazer sentido. Rodar:
 *   1) `rm -rf .next && npx next build && npx playwright test -c
 *      playwright.speed-insights.config.ts --grep "fora da Vercel"`
 *   2) `rm -rf .next && VERCEL=1 npx next build && VERCEL=1 npx playwright
 *      test -c playwright.speed-insights.config.ts --grep "na Vercel"`
 */
const isVercelRuntime = process.env.VERCEL === '1';
const SPEED_INSIGHTS_PATH = '/_vercel/speed-insights/script.js';

test.describe('SpeedInsights — gating por runtime da Vercel (#639)', () => {
  test('fora da Vercel: nenhuma requisição ao script da Vercel, sem 404 inexplicado', async ({ page }) => {
    test.skip(isVercelRuntime, 'roda só quando VERCEL não está setado (runtime local/não-Vercel)');

    const speedInsightsRequests: string[] = [];
    const unexplained404s: string[] = [];

    page.on('request', (request) => {
      if (request.url().includes(SPEED_INSIGHTS_PATH)) {
        speedInsightsRequests.push(request.url());
      }
    });
    page.on('response', (response) => {
      if (response.status() === 404) {
        unexplained404s.push(`${response.status()} ${response.url()}`);
      }
    });

    await page.goto('/login');
    // dá tempo para o useEffect do componente (se montado) injetar o <script>.
    await page.waitForTimeout(1500);

    expect(speedInsightsRequests).toEqual([]);
    expect(unexplained404s).toEqual([]);
  });

  test('na Vercel (VERCEL=1): a telemetria do Speed Insights continua montada', async ({ page }) => {
    test.skip(!isVercelRuntime, 'roda só quando VERCEL=1 (simula runtime da plataforma)');

    const speedInsightsRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(SPEED_INSIGHTS_PATH)) {
        speedInsightsRequests.push(request.url());
      }
    });

    await page.goto('/login');
    await page.waitForTimeout(1500);

    expect(speedInsightsRequests.length).toBeGreaterThan(0);
  });
});
