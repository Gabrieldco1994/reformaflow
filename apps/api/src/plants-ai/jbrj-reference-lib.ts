import { normalizeLabel } from './label-normalize';

const PIPE_DELIMITER = '|';
const DOUBLE_QUOTE = '"';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const UTF8_BOM = /^\uFEFF/;
const DISAPPEARED_TRUE_VALUE = 'T';
const EMPTY_VALUE = '';
const HEADER_FIELDS = {
  disappeared: 'desaparecido',
  taxonHtml: 'aux_nomecompltaxhtml',
  auxiliaryCommonName: 'aux_nomevulg',
  plateCommonName: 'placa_nomevulgar',
} as const;
const JBRJ_RANK_TOKENS = new Set(['subsp.', 'ssp.', 'var.', 'subvar.', 'f.', 'forma', 'cv.']);
const INDETERMINATE_LABEL = 'indeterminada';

export const JBRJ_ATTRIBUTION = {
  title: 'Acervo da Coleção Viva',
  author: 'Coordenação de Coleções Vivas/DICAT — Jardim Botânico do Rio de Janeiro',
  license: 'CC-BY',
  source: 'https://ckan.jbrj.gov.br/dataset/acervo-colecao-viva',
} as const;

export type JbrjReferenceTuple = [scientificName: string, family: string, commonName: string];

export interface JbrjReferenceFixture {
  attribution: typeof JBRJ_ATTRIBUTION;
  entries: JbrjReferenceTuple[];
}

export interface JbrjReferenceEntry {
  scientificName: string;
  family: string;
  commonName: string;
}

export interface PlantDiagnosisCandidateLike {
  nomePopular: string;
  nomeCientifico: string;
}

export interface PlantDiagnosisLike {
  especieProvavel: PlantDiagnosisCandidateLike;
  especiesAlternativas?: PlantDiagnosisCandidateLike[];
}

interface CommonNameAggregate {
  count: number;
  displayName: string;
  sourcePriority: number;
}

interface TaxonAggregate {
  scientificName: string;
  family: string;
  commonNames: Map<string, CommonNameAggregate>;
}

const fixtureIndexCache = new WeakMap<JbrjReferenceFixture, Map<string, JbrjReferenceEntry>>();

export function parsePipeDelimitedRows(input: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = EMPTY_VALUE;
  let insideQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? EMPTY_VALUE;

    if (insideQuotes) {
      if (char === DOUBLE_QUOTE) {
        if (input[index + 1] === DOUBLE_QUOTE) {
          currentField += DOUBLE_QUOTE;
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        currentField += char;
      }
      continue;
    }

    if (char === DOUBLE_QUOTE) {
      insideQuotes = true;
      continue;
    }

    if (char === PIPE_DELIMITER) {
      currentRow.push(currentField);
      currentField = EMPTY_VALUE;
      continue;
    }

    if (char === CARRIAGE_RETURN) {
      if (input[index + 1] === LINE_FEED) {
        continue;
      }
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = EMPTY_VALUE;
      continue;
    }

    if (char === LINE_FEED) {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = EMPTY_VALUE;
      continue;
    }

    currentField += char;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length > 0 && rows[0]?.length) {
    rows[0][0] = rows[0][0].replace(UTF8_BOM, EMPTY_VALUE);
  }

  return rows;
}

export function buildJbrjReferenceFixture(input: string): JbrjReferenceFixture {
  const rows = parsePipeDelimitedRows(input);
  if (rows.length === 0) {
    return { attribution: JBRJ_ATTRIBUTION, entries: [] };
  }

  const header = rows[0] ?? [];
  const indices = getColumnIndices(header);
  const speciesByNormalizedName = new Map<string, TaxonAggregate>();

  for (const row of rows.slice(1)) {
    if (row.length === 0 || isRepeatedHeaderRow(row, header)) {
      continue;
    }

    const disappeared = getCell(row, indices.disappeared);
    if (disappeared === DISAPPEARED_TRUE_VALUE) {
      continue;
    }

    const taxonHtml = getCell(row, indices.taxonHtml);
    const scientificName = extractScientificName(taxonHtml);
    if (!scientificName || normalizeLabel(scientificName) === INDETERMINATE_LABEL) {
      continue;
    }

    const family = extractFamily(taxonHtml);
    if (!family) {
      continue;
    }

    const preferredCommonName = extractPreferredCommonName(row, indices);
    if (!preferredCommonName) {
      continue;
    }

    const scientificNameKey = normalizeLabel(scientificName);
    const aggregate = speciesByNormalizedName.get(scientificNameKey) ?? {
      scientificName,
      family,
      commonNames: new Map<string, CommonNameAggregate>(),
    };
    speciesByNormalizedName.set(scientificNameKey, aggregate);
    addCommonNameCandidate(aggregate.commonNames, preferredCommonName.value, preferredCommonName.sourcePriority);
  }

  const entries = [...speciesByNormalizedName.values()]
    .map(({ scientificName, family, commonNames }) => [
      scientificName,
      family,
      pickPrimaryCommonName(commonNames),
    ] as JbrjReferenceTuple)
    .sort((left, right) => compareStrings(normalizeLabel(left[0]), normalizeLabel(right[0])));

  return {
    attribution: JBRJ_ATTRIBUTION,
    entries,
  };
}

export function findExactJbrjReferenceEntry(
  scientificName: string,
  fixture: JbrjReferenceFixture,
): JbrjReferenceEntry | undefined {
  const normalizedScientificName = normalizeLabel(scientificName);
  if (!normalizedScientificName) {
    return undefined;
  }
  return getReferenceIndex(fixture).get(normalizedScientificName);
}

export function normalizeDiagnosisCommonNamesFromJbrj<T extends PlantDiagnosisLike>(
  diagnosis: T,
  fixture: JbrjReferenceFixture,
): T {
  const especieProvavel = normalizeDiagnosisCandidate(diagnosis.especieProvavel, fixture);
  const especiesAlternativas = diagnosis.especiesAlternativas?.map((candidate) =>
    normalizeDiagnosisCandidate(candidate, fixture),
  );
  const topLevelChanged = especieProvavel !== diagnosis.especieProvavel;
  const alternativesChanged = Boolean(
    especiesAlternativas?.some((candidate, index) => candidate !== diagnosis.especiesAlternativas?.[index]),
  );

  if (!topLevelChanged && !alternativesChanged) {
    return diagnosis;
  }

  return {
    ...diagnosis,
    especieProvavel,
    ...(diagnosis.especiesAlternativas ? { especiesAlternativas } : {}),
  } as T;
}

function getColumnIndices(header: string[]) {
  return {
    disappeared: getRequiredColumnIndex(header, HEADER_FIELDS.disappeared),
    taxonHtml: getRequiredColumnIndex(header, HEADER_FIELDS.taxonHtml),
    auxiliaryCommonName: getRequiredColumnIndex(header, HEADER_FIELDS.auxiliaryCommonName),
    plateCommonName: getRequiredColumnIndex(header, HEADER_FIELDS.plateCommonName),
  };
}

function getRequiredColumnIndex(header: string[], columnName: string): number {
  const index = header.indexOf(columnName);
  if (index >= 0) {
    return index;
  }
  throw new Error(`Coluna obrigatória ausente no CSV da JBRJ: ${columnName}`);
}

function getCell(row: string[], index: number): string {
  return collapseWhitespace(row[index] ?? EMPTY_VALUE);
}

function isRepeatedHeaderRow(row: string[], header: string[]): boolean {
  if (row.length < header.length) {
    return false;
  }
  return header.every((value, index) => row[index] === value);
}

function extractPreferredCommonName(
  row: string[],
  indices: ReturnType<typeof getColumnIndices>,
): { value: string; sourcePriority: number } | undefined {
  const plateCommonName = getCell(row, indices.plateCommonName);
  if (plateCommonName) {
    return { value: plateCommonName, sourcePriority: 0 };
  }

  const auxiliaryCommonName = getCell(row, indices.auxiliaryCommonName);
  if (auxiliaryCommonName) {
    return { value: auxiliaryCommonName, sourcePriority: 1 };
  }

  return undefined;
}

function extractFamily(taxonHtml: string): string | undefined {
  const family = collapseWhitespace(taxonHtml.split('<i>', 1)[0] ?? EMPTY_VALUE);
  return family || undefined;
}

function extractScientificName(taxonHtml: string): string | undefined {
  const italicMatches = [...taxonHtml.matchAll(/<i>(.*?)<\/i>/g)];
  if (italicMatches.length < 2) {
    return undefined;
  }

  const parts: string[] = [];
  for (let index = 0; index < italicMatches.length; index += 1) {
    const currentMatch = italicMatches[index];
    const italicText = collapseWhitespace(currentMatch[1] ?? EMPTY_VALUE);
    if (italicText) {
      parts.push(italicText);
    }

    const nextMatch = italicMatches[index + 1];
    if (!nextMatch || currentMatch.index === undefined || nextMatch.index === undefined) {
      continue;
    }

    const betweenTags = taxonHtml.slice(currentMatch.index + currentMatch[0].length, nextMatch.index);
    parts.push(...extractRankTokens(betweenTags));
  }

  const nonRankPartCount = parts.filter((part) => !JBRJ_RANK_TOKENS.has(part.toLowerCase())).length;
  if (nonRankPartCount < 2) {
    return undefined;
  }

  return collapseWhitespace(parts.join(' ')) || undefined;
}

function extractRankTokens(fragment: string): string[] {
  return fragment
    .split(/\s+/)
    .map((token) => token.replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, EMPTY_VALUE).toLowerCase())
    .filter((token) => JBRJ_RANK_TOKENS.has(token));
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function addCommonNameCandidate(
  candidates: Map<string, CommonNameAggregate>,
  commonName: string,
  sourcePriority: number,
): void {
  const normalizedCommonName = normalizeLabel(commonName);
  if (!normalizedCommonName) {
    return;
  }

  const existing = candidates.get(normalizedCommonName);
  if (!existing) {
    candidates.set(normalizedCommonName, {
      count: 1,
      displayName: commonName,
      sourcePriority,
    });
    return;
  }

  existing.count += 1;
  if (sourcePriority < existing.sourcePriority) {
    existing.displayName = commonName;
    existing.sourcePriority = sourcePriority;
    return;
  }

}

function pickPrimaryCommonName(candidates: Map<string, CommonNameAggregate>): string {
  const [primary] = [...candidates.entries()].sort((left, right) => {
    const aggregateDelta = right[1].count - left[1].count;
    if (aggregateDelta !== 0) {
      return aggregateDelta;
    }

    const sourcePriorityDelta = left[1].sourcePriority - right[1].sourcePriority;
    if (sourcePriorityDelta !== 0) {
      return sourcePriorityDelta;
    }

    const normalizedDelta = compareStrings(left[0], right[0]);
    if (normalizedDelta !== 0) {
      return normalizedDelta;
    }

    return compareStrings(left[1].displayName, right[1].displayName);
  });

  return primary?.[1].displayName ?? EMPTY_VALUE;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function getReferenceIndex(fixture: JbrjReferenceFixture): Map<string, JbrjReferenceEntry> {
  const cached = fixtureIndexCache.get(fixture);
  if (cached) {
    return cached;
  }

  const index = new Map<string, JbrjReferenceEntry>();
  for (const [scientificName, family, commonName] of fixture.entries) {
    index.set(normalizeLabel(scientificName), {
      scientificName,
      family,
      commonName,
    });
  }
  fixtureIndexCache.set(fixture, index);
  return index;
}

function normalizeDiagnosisCandidate<T extends PlantDiagnosisCandidateLike>(
  candidate: T,
  fixture: JbrjReferenceFixture,
): T {
  const exactMatch = findExactJbrjReferenceEntry(candidate.nomeCientifico, fixture);
  if (!exactMatch || exactMatch.commonName === candidate.nomePopular) {
    return candidate;
  }

  return {
    ...candidate,
    nomePopular: exactMatch.commonName,
  } as T;
}
