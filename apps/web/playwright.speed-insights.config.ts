import { defineConfig, devices } from '@playwright/test';

/**
 * Config isolada para #639: reproduz o cenário real do bug, que só existe em
 * `next build && next start` (produção local fora da Vercel) — `next dev`
 * seta NODE_ENV=development e o pacote @vercel/speed-insights já usa um
 * script hospedado externamente nesse modo, então NUNCA pega o 404 local.
 * Porta própria (3639, livre — ver AGENTS.md sobre portas reservadas de
 * outras worktrees) para não colidir com o `playwright.config.ts` padrão
 * (3013, `next dev`) nem com outros agentes rodando em paralelo.
 *
 * Pré-requisito: `next build` já executado nesta árvore (o `webServer`
 * abaixo só sobe o servidor de produção, não builda).
 */
const PORT = Number(process.env.PLAYWRIGHT_SI_PORT ?? 3639);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e-speed-insights',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
