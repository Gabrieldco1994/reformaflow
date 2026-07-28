/* LifeOne — service worker.
 *
 * Princípio number one, por ser app financeiro: NUNCA servir dinheiro velho.
 * Nada que venha da API é cacheado, em hipótese alguma. O cache existe só
 * para o casco do app (JS/CSS/imagens) e para uma página de offline.
 *
 * A segunda armadilha que este arquivo evita de propósito é a clássica do
 * service worker: servir build antiga e fazer o time caçar fantasma achando
 * que o deploy não subiu. Por isso navegação é SEMPRE network-first (o cache
 * só entra quando a rede falhou) e o SW novo assume na hora (skipWaiting +
 * clients.claim), em vez de esperar todas as abas fecharem.
 *
 * Ao mexer nas estratégias, suba o VERSION — o activate limpa todo cache que
 * não seja da versão corrente.
 */

const VERSION = 'v1';
const STATIC_CACHE = `lifeone-static-${VERSION}`;
const SHELL_CACHE = `lifeone-shell-${VERSION}`;
const OFFLINE_URL = '/offline.html';

// Só o indispensável para a tela de offline funcionar sem rede.
const PRECACHE = [OFFLINE_URL, '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      // Assume imediatamente em vez de ficar em "waiting" até todas as abas
      // fecharem — sem isso, um deploy com correção urgente pode demorar dias
      // para valer em quem deixa a aba aberta.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== SHELL_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Só vale a pena guardar resposta completa, própria e bem-sucedida. */
function isCacheable(response) {
  return (
    response &&
    response.status === 200 &&
    response.type === 'basic' &&
    !response.redirected
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Mutação nunca passa por cache.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Outra origem (a API no Fly, Google, telemetria) — deixa passar direto.
  if (url.origin !== self.location.origin) return;

  // A API também responde em /api/* via rewrite da Vercel. Dado financeiro
  // NÃO é cacheado: melhor falhar e a tela mostrar erro do que exibir saldo
  // de ontem como se fosse de agora.
  if (url.pathname.startsWith('/api/')) return;

  // Bundles do Next são versionados por hash no nome: quando o conteúdo muda,
  // a URL muda. Logo, cache-first é seguro e evita rede no carregamento.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (isCacheable(response)) {
              const copy = response.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Navegação: network-first. O cache é rede de segurança para quando não há
  // conexão — nunca a fonte preferida, senão o app serve build antiga.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isCacheable(response)) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((hit) => hit || caches.match(OFFLINE_URL)),
        ),
    );
    return;
  }

  // Demais estáticos da própria origem (ícones, manifest, fontes): responde do
  // cache na hora e revalida em segundo plano.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (isCacheable(response)) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
