import {
  JBRJ_ATTRIBUTION,
  buildJbrjReferenceFixture,
  findExactJbrjReferenceEntry,
  normalizeDiagnosisCommonNamesFromJbrj,
  parsePipeDelimitedRows,
  type JbrjReferenceFixture,
} from './jbrj-reference-lib';

describe('jbrj reference ETL', () => {
  it('parses quoted multiline pipe-delimited rows', () => {
    const rows = parsePipeDelimitedRows(
      'desaparecido|aux_nomecompltaxhtml|aux_nomevulg|placa_nomevulgar\n'
        + '|"ARECACEAE <i>Archontophoenix</i>\n<i>alexandrae</i>"|palmeira-real-australiana|\n',
    );

    expect(rows).toEqual([
      ['desaparecido', 'aux_nomecompltaxhtml', 'aux_nomevulg', 'placa_nomevulgar'],
      ['', 'ARECACEAE <i>Archontophoenix</i>\n<i>alexandrae</i>', 'palmeira-real-australiana', ''],
    ]);
  });

  it('filters disappeared or non-species rows and dedupes species names', () => {
    const header = 'desaparecido|aux_nomecompltaxhtml|aux_nomevulg|placa_nomevulgar';
    const csv = [
      header,
      '|ARECACEAE <i>Archontophoenix</i> <i>alexandrae</i>|palmeira-real-australiana|',
      '|ARECACEAE <i>Archontophoenix</i> <i>ALEXANDRAE</i>|Palmeira-real-australiana|',
      'T|ARECACEAE <i>Archontophoenix</i> <i>alexandrae</i>|deveria sumir|',
      header,
      '|MALVACEAE||',
      '|ARACEAE <i>Anthurium</i>|anturio|',
      '|INDETERMINADA|farinha-seca|',
      'F|ARACEAE <i>Anthurium</i> <i>harrisii</i>||antúrio-do-brejo',
    ].join('\n');

    expect(buildJbrjReferenceFixture(csv)).toEqual({
      attribution: JBRJ_ATTRIBUTION,
      entries: [
        ['Anthurium harrisii', 'ARACEAE', 'antúrio-do-brejo'],
        ['Archontophoenix alexandrae', 'ARECACEAE', 'palmeira-real-australiana'],
      ],
    });
  });

  it('finds only exact scientific-name matches after normalization', () => {
    const fixture: JbrjReferenceFixture = {
      attribution: JBRJ_ATTRIBUTION,
      entries: [['Abarema cochliacarpos', 'LEGUMINOSAE', 'bordão-de-velho']],
    };

    expect(findExactJbrjReferenceEntry('Abarema cochliacarpos', fixture)?.commonName).toBe('bordão-de-velho');
    expect(findExactJbrjReferenceEntry('Abarema cochliacarpos (Gomes) Barneby & J.W.Grimes', fixture)).toBeUndefined();
  });

  it('normalizes common names without altering scientific identification', () => {
    const fixture: JbrjReferenceFixture = {
      attribution: JBRJ_ATTRIBUTION,
      entries: [
        ['Abarema cochliacarpos', 'LEGUMINOSAE', 'bordão-de-velho'],
        ['Anthurium harrisii', 'ARACEAE', 'antúrio-do-brejo'],
      ],
    };
    const diagnosis = {
      especieProvavel: {
        nomePopular: 'nome genérico',
        nomeCientifico: 'Abarema cochliacarpos',
        confianca: 0.91,
      },
      especiesAlternativas: [
        { nomePopular: 'sem match', nomeCientifico: 'Ficus lyrata', confianca: 0.2 },
        { nomePopular: 'outro nome', nomeCientifico: 'Anthurium harrisii', confianca: 0.1 },
      ],
      saude: { status: 'SAUDAVEL' as const, confianca: 0.7, sinais: [] },
      pet: { risco: 'DESCONHECIDO' as const, observacao: '' },
      cuidados: { rega: '', luz: '', poda: '', adubacao: '', solo: '' },
      problemasPossiveis: [],
    };

    expect(normalizeDiagnosisCommonNamesFromJbrj(diagnosis, fixture)).toEqual({
      ...diagnosis,
      especieProvavel: {
        ...diagnosis.especieProvavel,
        nomePopular: 'bordão-de-velho',
      },
      especiesAlternativas: [
        diagnosis.especiesAlternativas[0],
        {
          ...diagnosis.especiesAlternativas[1],
          nomePopular: 'antúrio-do-brejo',
        },
      ],
    });
  });
});
