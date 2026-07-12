import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildJbrjReferenceFixture } from './jbrj-reference-lib';

const SOURCE_ARGUMENT_INDEX = 2;
const OUTPUT_FILENAME = 'jbrj-common-names.json';

function main(): void {
  const sourcePath = process.argv[SOURCE_ARGUMENT_INDEX];
  if (!sourcePath) {
    throw new Error(
      'Uso: npx ts-node src/plants-ai/build-jbrj-reference.ts /caminho/para/colecao_viva_2020.csv',
    );
  }

  const csv = fs.readFileSync(sourcePath, 'utf8');
  const fixture = buildJbrjReferenceFixture(csv);
  const outputPath = path.resolve(__dirname, 'eval-fixtures', OUTPUT_FILENAME);
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture)}\n`, 'utf8');
  console.log(`JBRJ fixture gerado: ${fixture.entries.length} entradas em ${outputPath}`);
}

main();
