// Categorizador determinístico por keywords no merchant (reaproveitado).
// Para casos em que a fonte não envia categoria (PDF/OFX/CSV puro), aplicamos
// um classificador simples. O usuário pode sobrescrever depois.
const CATEGORIES: Array<[string, RegExp[]]> = [
  ['alimentação', [
    /ifood/i, /\bifd\b/i, /99food/i, /keeta/i, /uber\s*eats/i, /rappi/i, /restaurante/i,
    /restaur/i, /padaria/i, /lanchonete/i, /lanches/i, /mc\s*donald/i, /burger/i, /burguer/i,
    /hamburg/i, /subway/i, /pizza/i, /\bbar\b/i, /supermercado/i, /carrefour/i,
    /pao\s*de\s*acucar/i, /\bextra\b/i, /assa[ií]/i, /\bmercado\b/i, /\bcafe\b/i, /cafeteria/i,
    /bistr/i, /gastron/i, /churrasc/i, /\bgrill\b/i, /\bbagel\b/i, /\bdeli\b/i, /cozinha/i,
    /\bsabor\b/i, /forneria/i, /outback/i, /wholefds/i, /\bmeat\b/i, /chocolate/i, /sorveter/i,
    /\bacai\b/i, /churros/i, /confeitaria/i, /doceria/i, /\bsushi\b/i, /temaki/i, /\bgrill/i,
  ]],
  ['transporte', [
    /\buber\b/i, /\b99\s/i, /99app/i, /\b99\b/i, /cabify/i, /\bposto\b/i, /shell/i, /ipiranga/i,
    /estapar/i, /pedagio/i, /metr[oô]/i, /cptm/i, /bilhete/i, /lyft/i, /\bzul\b/i,
    /zona\s*azul/i, /nyct/i, /\bmta\b/i, /estacionamento/i, /parking/i,
  ]],
  ['assinaturas', [
    /netflix/i, /spotify/i, /amazon\s*prime/i, /disney/i, /hbo/i, /apple\.com/i, /applecom/i,
    /\bapple\b/i, /\bgoogle\b/i, /icloud/i, /youtube/i, /openai/i, /chatgpt/i, /claude/i,
    /github/i, /vercel/i, /notion/i, /dropbox/i, /microsoft/i, /deezer/i, /tiktok/i,
    /assinatura/i, /\btim\b/i, /\bvivo\b/i, /\bclaro\b/i, /oculus/i,
  ]],
  ['viagem', [
    /decolar/i, /latam/i, /gol\s*linhas/i, /\bazul\b/i, /booking/i, /airbnb/i,
    /\bhotel\b/i, /hostel/i, /expedia/i, /kiwi\.com/i, /rentcars/i,
  ]],
  ['saúde', [
    /drogaria/i, /drogasil/i, /\braia\b/i, /pacheco/i, /farm[aá]cia/i, /consulta/i,
    /hospital/i, /clinica/i, /\blab\b/i, /laboratorio/i, /fleury/i, /dasa/i, /amil/i,
    /unimed/i, /bradesco\s*saude/i, /academia/i, /smartfit/i, /\bgym\b/i,
  ]],
  ['compras', [
    /amazon/i, /mercado\s*livre/i, /magalu/i, /magazine\s*luiza/i, /shopee/i, /aliexpress/i,
    /americanas/i, /shein/i, /\blojas\b/i, /renner/i, /c&a/i, /zara/i, /riachuelo/i,
    /sportswear/i, /hering/i, /jomashop/i, /\bnike\b/i, /adidas/i,
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
