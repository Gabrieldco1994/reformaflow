export const PLANTS_REFERENCE_SOURCES = [
  'Kew Plants of the World Online (POWO) — taxonomia e sinonímia botânica',
  'GBIF Backbone Taxonomy — nomenclatura e distribuição global',
  'Flora e Funga do Brasil (JBRJ) — nomenclatura e contexto brasileiro',
  'ASPCA Toxic and Non-Toxic Plants — risco para cães e gatos',
  'RHS Plant Finder/Care — manejo hortícola e boas práticas',
  'EPPO Global Database — pragas e doenças de plantas',
  'Embrapa (publicações técnicas) — recomendações agronômicas em clima brasileiro',
] as const;

export function buildPlantDiagnosisPrompt(): string {
  return `Você é um especialista em botânica e fitopatologia.
Analise a imagem e retorne SOMENTE JSON válido, sem markdown.

Use como base conceitual prioritária:
${PLANTS_REFERENCE_SOURCES.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Formato obrigatório:
{
  "especieProvavel": {
    "nomePopular": "string",
    "nomeCientifico": "string",
    "confianca": 0.0
  },
  "especiesAlternativas": [
    { "nomePopular": "string", "nomeCientifico": "string", "confianca": 0.0 }
  ],
  "saude": {
    "status": "SAUDAVEL|ATENCAO|CRITICA",
    "confianca": 0.0,
    "sinais": ["string"]
  },
  "pet": {
    "risco": "SEGURO|CAUTELA|TOXICA|DESCONHECIDO",
    "observacao": "string",
    "fonteReferencia": "ASPCA|desconhecido"
  },
  "cuidados": {
    "rega": "string",
    "luz": "string",
    "poda": "string",
    "adubacao": "string",
    "solo": "string"
  },
  "problemasPossiveis": [
    {
      "nome": "string",
      "gravidade": "BAIXA|MEDIA|ALTA",
      "probabilidade": 0.0,
      "descricao": "string",
      "planoAcao": ["string"]
    }
  ],
  "qualidadeImagem": {
    "status": "BOA|LIMITADA|RUIM",
    "motivos": ["string"],
    "recomendarNovaFoto": true
  }
}
Regras:
- Seja conservador na confiança.
- Se houver incerteza relevante, use "especiesAlternativas".
- Se a imagem mostrar só um fragmento (caule isolado, folha única sem visão da planta inteira),
  reduza a confiança da espécie e prefira citar gênero/família a "adivinhar" a espécie exata.
- Sinais leves (1-2 pequenas manchas, pontos localizados) ainda contam como saude ATENCAO —
  não marque SAUDAVEL só porque o sinal é pequeno.
- Amarelamento/ressecamento leve e isolado na PONTA de uma única folha, sem manchas nem padrão
  repetido em outras folhas, costuma ser senescência natural — não é motivo isolado para ATENCAO.
- Se não houver doença aparente, problemasPossiveis pode ser [].
- Não invente toxicidade: use "DESCONHECIDO" quando não tiver segurança.
- Quando a imagem estiver fraca, marque qualidadeImagem como LIMITADA/RUIM.
- Resposta em pt-BR.`;
}
