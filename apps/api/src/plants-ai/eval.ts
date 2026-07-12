import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildPlantDiagnosisPrompt } from './diagnosis-prompt';
import type { PlantDiagnosisResult } from './plants-ai.service';
import {
  computeEvalMetrics,
  findCareReference,
  findToxicityReference,
  type PlantEvalCase,
} from './eval-lib';

interface DatasetFile {
  cases: PlantEvalCase[];
}

async function callGeminiWithImage(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<PlantDiagnosisResult> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada');
  }
  const model = process.env['PLANTS_AI_MODEL'] ?? 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: buildPlantDiagnosisPrompt() },
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBuffer.toString('base64'),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 16384,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 250)}`);
  }
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Resposta vazia do Gemini');
  return JSON.parse(text) as PlantDiagnosisResult;
}

function inferMimeType(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

async function main() {
  const datasetArg = process.argv[2] ?? 'src/plants-ai/eval-fixtures/cases.json';
  console.log('Coloque suas fotos em: src/plants-ai/eval-fixtures/images/upload-aqui/');
  const datasetPath = resolve(process.cwd(), datasetArg);
  const datasetRaw = await readFile(datasetPath, 'utf-8');
  const dataset = JSON.parse(datasetRaw) as DatasetFile;
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error('Dataset sem casos');
  }

  const results = new Map<string, PlantDiagnosisResult>();
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const c of dataset.cases) {
    const imagePath = resolve(process.cwd(), c.imagePath);
    try {
      const buffer = await readFile(imagePath);
      const diagnosis = await callGeminiWithImage(buffer, inferMimeType(imagePath));
      results.set(c.id, diagnosis);
      console.log(`[ok] ${c.id} -> ${diagnosis.especieProvavel.nomePopular} (${diagnosis.saude.status})`);
      const care = findCareReference(diagnosis.especieProvavel.nomeCientifico || diagnosis.especieProvavel.nomePopular);
      if (care) {
        console.log(`      cuidados IA: rega="${diagnosis.cuidados.rega}" | luz="${diagnosis.cuidados.luz}"`);
        console.log(`      referência (${care.latin}): rega="${care.watering}" | luz ideal="${care.ideallight}" | pragas comuns=${care.insects.join(', ')}`);
      }
      const toxicity = findToxicityReference(diagnosis.especieProvavel.nomeCientifico);
      if (toxicity) {
        const RISCO_MAP: Record<string, string> = { toxic: 'TOXICA', 'non-toxic': 'SEGURO', unknown: 'DESCONHECIDO' };
        const realRisco = RISCO_MAP[toxicity.toxicCat] ?? 'DESCONHECIDO';
        const match = realRisco === diagnosis.pet.risco ? 'OK' : 'DIVERGIU';
        console.log(`      riscoPet IA="${diagnosis.pet.risco}" vs ASPCA(gato)="${realRisco}" [${match}]`);
      }
    } catch (err) {
      skipped.push({
        id: c.id,
        reason: err instanceof Error ? err.message : 'erro desconhecido',
      });
      console.warn(`[skip] ${c.id} -> ${skipped[skipped.length - 1].reason}`);
    }
  }

  const evaluatedCases = dataset.cases.filter((c) => results.has(c.id));
  const metrics = computeEvalMetrics(evaluatedCases, results);
  console.log('\n=== PLANTS AI EVAL ===');
  console.log(JSON.stringify(metrics, null, 2));
  if (skipped.length > 0) {
    console.log('\n=== SKIPPED ===');
    console.log(JSON.stringify(skipped, null, 2));
  }
}

void main();
