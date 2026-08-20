import { defineConfig, devices } from '@playwright/test';

/**
 * A porta é PARAMETRIZÁVEL (mesmo valor de sempre por omissão).
 *
 * `reuseExistingServer` é ligado fora de CI, e este monorepo roda várias
 * worktrees em paralelo: se a 3013 já estiver ocupada pelo `next dev` de OUTRO
 * agente, a suíte inteira mede o código dele e reporta verde sobre mudanças
 * que não existem na sua árvore. Aconteceu nesta issue (#505): 7 testes
 * "passaram" contra `/tmp/rf-490-dd`. Com `PLAYWRIGHT_PORT` cada worktree mede
 * a si mesma.
 */
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3013);
const baseURL = `http://localhost:${PORT}`;

/**
 * E2E de responsividade (breakpoint real no DOM, impossível de asseverar em jsdom).
 * Roda o app com `next dev` e valida os layouts desktop vs mobile.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
