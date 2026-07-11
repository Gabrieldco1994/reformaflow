import type { PlantDiagnosisResult } from './plants-ai.service';
import { normalizeLabel } from './label-normalize';

export interface PlantEvalCase {
  id: string;
  imagePath: string;
  expected: {
    especie: string;
    saude: 'SAUDAVEL' | 'ATENCAO' | 'CRITICA';
    riscoPet: 'SEGURO' | 'CAUTELA' | 'TOXICA' | 'DESCONHECIDO';
    temProblema: boolean;
  };
}

/**
 * Datasets de referência para montar casos de eval reais (ver README em
 * eval-fixtures/). PlantVillage e Indoor Plant Disease Detection cobrem a
 * dimensão "saúde/doença" (culturas agrícolas e plantas de interior,
 * respectivamente); House Plant Species amplia a diversidade de espécies
 * (só plantas saudáveis, sem doença); OpenPlant (artigo PMC12986848) é citado
 * como referência de amplitude de espécies e metodologia de benchmark com
 * VLMs, mas não tem download único público (635k imgs agregadas de 41
 * repositórios) — não é alvo de automação aqui, só leitura/inspiração.
 */
export const EVAL_DATASET_SOURCES = [
  {
    name: 'PlantVillage',
    url: 'https://www.kaggle.com/datasets/abdallahalidev/plantvillage-dataset',
    usage: 'saude (doente/saudável) — 38 classes cultura___condicao, mapeáveis via plantVillageLabelToEvalCase()',
  },
  {
    name: 'Indoor Plant Disease Detection Dataset',
    url: 'https://www.kaggle.com/datasets/abdulahad0296/indoor-plant-disease-detection-dataset',
    usage: 'saude + especie — plantas de interior reais (babosa, cacto, jade, espada-de-são-jorge, clorofito), 16 classes especie___condicao',
  },
  {
    name: 'House Plant Species',
    url: 'https://www.kaggle.com/datasets/kacpergregorowicz/house-plant-species',
    usage: 'especie (47 classes de plantas saudáveis) — riscoPet NÃO vem do dataset (só tem fotos por espécie, sem rótulo de toxicidade apesar da descrição do autor); anotado manualmente com base ASPCA, igual à referência já citada no prompt',
  },
  {
    name: 'Plant Dataset',
    url: 'https://www.kaggle.com/datasets/yousra15b/plant-dataset',
    usage: 'especie (28 classes ornamentais, incluindo flores e plantas de interior) — amostra de 1 imagem por classe em species-cases.json; sem rótulos de saúde ou toxicidade',
  },
  {
    name: 'ASPCA Plant Toxicity Info',
    url: 'https://www.kaggle.com/datasets/pelinkeskin/aspca-plant-toxicity-info',
    usage: 'riscoPet REAL (1896 espécies, toxicidade cão/gato/cavalo) — findToxicityReference() em eval-lib.ts; 12 fotos reais mapeadas em cases.json com riscoPet vindo do CSV (Toxicity_Cat), não de achismo',
  },
  {
    name: 'OpenPlant (PMC12986848)',
    url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC12986848/',
    usage: 'referência de amplitude de espécies e metodologia de benchmark com VLMs — sem download único, só consulta manual',
  },
] as const;

/** Rótulos do PlantVillage no formato "Cultura___condicao" (ex.: "Tomato___Late_blight", "Apple___healthy"). */
export const PLANT_VILLAGE_CLASSES = [
  'Apple___Apple_scab',
  'Apple___Black_rot',
  'Apple___Cedar_apple_rust',
  'Apple___healthy',
  'Blueberry___healthy',
  'Cherry_(including_sour)___Powdery_mildew',
  'Cherry_(including_sour)___healthy',
  'Corn_(maize)___Cercospora_leaf_spot Gray_leaf_spot',
  'Corn_(maize)___Common_rust_',
  'Corn_(maize)___Northern_Leaf_Blight',
  'Corn_(maize)___healthy',
  'Grape___Black_rot',
  'Grape___Esca_(Black_Measles)',
  'Grape___Leaf_blight_(Isariopsis_Leaf_Spot)',
  'Grape___healthy',
  'Orange___Haunglongbing_(Citrus_greening)',
  'Peach___Bacterial_spot',
  'Peach___healthy',
  'Pepper,_bell___Bacterial_spot',
  'Pepper,_bell___healthy',
  'Potato___Early_blight',
  'Potato___Late_blight',
  'Potato___healthy',
  'Raspberry___healthy',
  'Soybean___healthy',
  'Squash___Powdery_mildew',
  'Strawberry___Leaf_scorch',
  'Strawberry___healthy',
  'Tomato___Bacterial_spot',
  'Tomato___Early_blight',
  'Tomato___Late_blight',
  'Tomato___Leaf_Mold',
  'Tomato___Septoria_leaf_spot',
  'Tomato___Spider_mites Two-spotted_spider_mite',
  'Tomato___Target_Spot',
  'Tomato___Tomato_Yellow_Leaf_Curl_Virus',
  'Tomato___Tomato_mosaic_virus',
  'Tomato___healthy',
] as const;

/**
 * Converte um rótulo do PlantVillage ("Cultura___condicao") em um PlantEvalCase.
 * ponytail: quando não é "healthy", assume saude=ATENCAO e riscoPet=DESCONHECIDO
 * por padrão (PlantVillage não classifica gravidade nem toxicidade para pets) —
 * ajuste manual em cases.json se algum caso específico for CRITICA ou tiver
 * risco pet conhecido.
 */
export function plantVillageLabelToEvalCase(
  label: string,
  imagePath: string,
  id: string,
): PlantEvalCase {
  const [culturaRaw, condicaoRaw] = label.split('___');
  const cultura = (culturaRaw ?? label).replace(/_/g, ' ').trim();
  const condicao = (condicaoRaw ?? '').trim();
  const isHealthy = condicao.toLowerCase() === 'healthy';
  return {
    id,
    imagePath,
    expected: {
      especie: cultura,
      saude: isHealthy ? 'SAUDAVEL' : 'ATENCAO',
      riscoPet: 'DESCONHECIDO',
      temProblema: !isHealthy,
    },
  };
}

export interface CareReferenceEntry {
  latin: string;
  common: string[];
  watering: string;
  ideallight: string;
  toleratedlight: string;
  insects: string[];
  diseases: string;
}

/**
 * Banco de cuidados reais por espécie (209 plantas de interior), sem imagens —
 * fonte: kaggle.com/datasets/prakash27x/indoor-house-plants-dataset-with-care-instructions
 * Usado só para comparação manual (rega/luz/pragas) durante o eval, não como
 * métrica automática: texto livre em pt-BR (Gemini) vs en-US (dataset) não dá
 * pra comparar por string match sem risco de falso sinal.
 * ponytail: comparação é impressa lado-a-lado no eval.ts para leitura humana;
 * se quiser score automático depois, dá pra classificar watering em categorias
 * grosseiras (ex. SECAR_ENTRE_REGAS vs MANTER_UMIDO) e comparar por categoria.
 */
let careReferenceCache: CareReferenceEntry[] | null = null;

export function loadCareReference(): CareReferenceEntry[] {
  if (careReferenceCache) return careReferenceCache;
  const raw = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, 'eval-fixtures/care-reference.json'),
    'utf-8',
  );
  careReferenceCache = JSON.parse(raw) as CareReferenceEntry[];
  return careReferenceCache;
}

export function findCareReference(
  speciesName: string,
  reference: CareReferenceEntry[] = loadCareReference(),
): CareReferenceEntry | undefined {
  const target = normalizeLabel(speciesName);
  if (!target) return undefined;
  return reference.find((entry) => {
    const latin = normalizeLabel(entry.latin);
    if (latin.includes(target) || target.includes(latin)) return true;
    return entry.common.some((c) => {
      const common = normalizeLabel(c);
      return common.includes(target) || target.includes(common);
    });
  });
}

export interface ToxicityReferenceEntry {
  name: string;
  scientificName: string;
  family: string;
  toxicDog: string;
  toxicCat: string;
  toxicHorse: string;
}

/**
 * Base real de toxicidade ASPCA (1896 registros: nome popular/científico x
 * cão/gato/cavalo) — fonte: kaggle.com/datasets/pelinkeskin/aspca-plant-toxicity-info
 * Usada para anotar `riscoPet` esperado em cases.json com dado real (Toxicity_Cat),
 * não achismo. Quando a espécie não tem match exato no CSV, o caso é marcado
 * DESCONHECIDO em vez de inventar risco.
 */
let toxicityReferenceCache: ToxicityReferenceEntry[] | null = null;

export function loadToxicityReference(): ToxicityReferenceEntry[] {
  if (toxicityReferenceCache) return toxicityReferenceCache;
  const raw = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, 'eval-fixtures/aspca-toxicity.json'),
    'utf-8',
  );
  toxicityReferenceCache = JSON.parse(raw) as ToxicityReferenceEntry[];
  return toxicityReferenceCache;
}

export function findToxicityReference(
  scientificName: string,
  reference: ToxicityReferenceEntry[] = loadToxicityReference(),
): ToxicityReferenceEntry | undefined {
  const target = normalizeLabel(scientificName);
  if (!target) return undefined;
  return reference.find((entry) => {
    const sci = normalizeLabel(entry.scientificName);
    return sci.includes(target) || target.includes(sci);
  });
}

export interface PlantEvalMetrics {
  total: number;
  speciesTop1: number;
  speciesTop3: number;
  saudeAccuracy: number;
  riscoPetAccuracy: number;
  problemaPresenceAccuracy: number;
}

export { normalizeLabel } from './label-normalize';

export function matchSpecies(
  diagnosis: PlantDiagnosisResult,
  expectedSpecies: string,
): { top1: boolean; top3: boolean } {
  const expected = normalizeLabel(expectedSpecies);
  const top1Candidate = normalizeLabel(diagnosis.especieProvavel.nomePopular);
  const alternatives = (diagnosis.especiesAlternativas ?? []).map((e) =>
    normalizeLabel(e.nomePopular),
  );
  const top1 = top1Candidate.includes(expected) || expected.includes(top1Candidate);
  if (top1) return { top1: true, top3: true };
  const top3List = [top1Candidate, ...alternatives].slice(0, 3);
  const top3 = top3List.some((s) => s.includes(expected) || expected.includes(s));
  return { top1: false, top3 };
}

export function computeEvalMetrics(
  cases: PlantEvalCase[],
  results: Map<string, PlantDiagnosisResult>,
): PlantEvalMetrics {
  const total = cases.length;
  let speciesTop1Hits = 0;
  let speciesTop3Hits = 0;
  let saudeHits = 0;
  let riscoPetHits = 0;
  let problemaPresenceHits = 0;

  for (const c of cases) {
    const r = results.get(c.id);
    if (!r) continue;
    const species = matchSpecies(r, c.expected.especie);
    if (species.top1) speciesTop1Hits++;
    if (species.top3) speciesTop3Hits++;
    if (r.saude.status === c.expected.saude) saudeHits++;
    if (r.pet.risco === c.expected.riscoPet) riscoPetHits++;
    const predictedHasProblem = r.problemasPossiveis.length > 0;
    if (predictedHasProblem === c.expected.temProblema) problemaPresenceHits++;
  }

  const pct = (n: number) => (total > 0 ? Number(((n / total) * 100).toFixed(2)) : 0);
  return {
    total,
    speciesTop1: pct(speciesTop1Hits),
    speciesTop3: pct(speciesTop3Hits),
    saudeAccuracy: pct(saudeHits),
    riscoPetAccuracy: pct(riscoPetHits),
    problemaPresenceAccuracy: pct(problemaPresenceHits),
  };
}
