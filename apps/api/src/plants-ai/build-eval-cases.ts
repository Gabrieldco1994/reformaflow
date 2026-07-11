/**
 * Gera casos de eval a partir de uma amostra local do PlantVillage
 * (https://www.kaggle.com/datasets/abdallahalidev/plantvillage-dataset),
 * organizada como `<pasta-origem>/<Cultura___condicao>/*.jpg` (é assim que o
 * dataset já vem no Kaggle). Mescla com o cases.json existente (por id).
 *
 * Uso:
 *   npx ts-node src/plants-ai/build-eval-cases.ts <pasta-com-classes-plantvillage> [limitePorClasse=3]
 *
 * ponytail: não baixa nem descompacta o dataset — isso fica manual (Kaggle
 * exige login). Este script só organiza o que já foi baixado em cases.json.
 */
import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { plantVillageLabelToEvalCase, type PlantEvalCase } from './eval-lib';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

async function main() {
  const sourceDir = process.argv[2];
  const limitPerClass = Number(process.argv[3] ?? 3);
  if (!sourceDir) {
    throw new Error('Uso: build-eval-cases.ts <pasta-plantvillage> [limitePorClasse]');
  }

  const fixturesDir = resolve(process.cwd(), 'src/plants-ai/eval-fixtures');
  const imagesDir = join(fixturesDir, 'images', 'plantvillage');
  await mkdir(imagesDir, { recursive: true });

  const casesPath = join(fixturesDir, 'cases.json');
  const existing = JSON.parse(await readFile(casesPath, 'utf-8')) as { cases: PlantEvalCase[] };
  const byId = new Map(existing.cases.map((c) => [c.id, c]));

  const classDirs = await readdir(resolve(process.cwd(), sourceDir), { withFileTypes: true });
  for (const classDir of classDirs) {
    if (!classDir.isDirectory()) continue;
    const label = classDir.name;
    const classPath = join(resolve(process.cwd(), sourceDir), label);
    const files = (await readdir(classPath)).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()));
    const sample = files.slice(0, limitPerClass);

    for (const file of sample) {
      const id = `pv-${label}-${file}`.replace(/[^a-zA-Z0-9._-]/g, '_');
      const destRelative = `src/plants-ai/eval-fixtures/images/plantvillage/${id}${extname(file)}`;
      await copyFile(join(classPath, file), resolve(process.cwd(), destRelative));
      byId.set(id, plantVillageLabelToEvalCase(label, destRelative, id));
    }
    console.log(`[ok] ${label}: ${sample.length} imagem(ns) adicionada(s)`);
  }

  await writeFile(casesPath, JSON.stringify({ cases: [...byId.values()] }, null, 2) + '\n');
  console.log(`\ncases.json atualizado com ${byId.size} casos.`);
}

void main();
