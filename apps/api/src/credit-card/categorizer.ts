// Categorizador determinístico por keywords no merchant (reaproveitado).
// Para casos em que a fonte não envia categoria (PDF/OFX/CSV puro), aplicamos
// um classificador simples. O usuário pode sobrescrever depois.
const CATEGORIES: Array<[string, RegExp[]]> = [
  ['alimentação', [
    /ifood/i, /uber\s*eats/i, /rappi/i, /restaurante/i, /padaria/i, /lanchonete/i,
    /mc\s*donald/i, /burger/i, /subway/i, /pizza/i, /\bbar\b/i, /supermercado/i,
    /carrefour/i, /pao\s*de\s*acucar/i, /\bextra\b/i, /assa[ií]/i, /mercado/i,
  ]],
  ['transporte', [
    /\buber\b/i, /\b99\s/i, /99app/i, /cabify/i, /\bposto\b/i, /shell/i, /ipiranga/i,
    /estapar/i, /pedagio/i, /metr[oô]/i, /cptm/i, /bilhete/i,
  ]],
  ['assinaturas', [
    /netflix/i, /spotify/i, /amazon\s*prime/i, /disney/i, /hbo/i, /apple\.com/i,
    /\bgoogle\b/i, /icloud/i, /youtube/i, /openai/i, /chatgpt/i, /github/i, /vercel/i,
    /notion/i, /dropbox/i, /microsoft/i, /deezer/i,
  ]],
  ['viagem', [
    /decolar/i, /latam/i, /gol\s*linhas/i, /\bazul\b/i, /booking/i, /airbnb/i,
    /\bhotel\b/i, /hostel/i, /expedia/i, /kiwi\.com/i, /rentcars/i,
  ]],
  ['saúde', [
    /drogaria/i, /drogasil/i, /\braia\b/i, /pacheco/i, /farm[aá]cia/i, /consulta/i,
    /hospital/i, /clinica/i, /\blab\b/i, /laboratorio/i, /fleury/i, /dasa/i, /amil/i,
    /unimed/i, /bradesco\s*saude/i,
  ]],
  ['compras', [
    /amazon/i, /mercado\s*livre/i, /magalu/i, /magazine\s*luiza/i, /shopee/i, /aliexpress/i,
    /americanas/i, /shein/i, /\blojas\b/i, /renner/i, /c&a/i, /zara/i, /riachuelo/i,
  ]],
  ['educação', [
    /udemy/i, /coursera/i, /alura/i, /rocketseat/i, /domestika/i, /skillshare/i,
    /\bescola\b/i, /faculdade/i, /\buni\b/i,
  ]],
  ['casa', [
    /leroy\s*merlin/i, /tok\s*stok/i, /casas\s*bahia/i, /telha\s*norte/i, /obramax/i,
    /decora/i, /ikea/i,
  ]],
];

export function categorize(merchant: string): string {
  const text = (merchant || '').toLowerCase();
  for (const [cat, patterns] of CATEGORIES) {
    if (patterns.some((p) => p.test(text))) return cat;
  }
  return 'outros';
}
