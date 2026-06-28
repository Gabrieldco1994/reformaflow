import { intToExtenso, valorToExtenso, verbalizeCurrency, stripEmoji } from './speech-format';

describe('intToExtenso', () => {
  it.each([
    [0, 'zero'],
    [1, 'um'],
    [15, 'quinze'],
    [100, 'cem'],
    [101, 'cento e um'],
    [199, 'cento e noventa e nove'],
    [1000, 'mil'],
    [1500, 'mil e quinhentos'],
    [3200, 'três mil e duzentos'],
    [2024, 'dois mil e vinte e quatro'],
    [100000, 'cem mil'],
    [181848, 'cento e oitenta e um mil oitocentos e quarenta e oito'],
    [1000000, 'um milhão'],
    [2500000, 'dois milhões e quinhentos mil'],
  ])('converte %i', (n, expected) => {
    expect(intToExtenso(n)).toBe(expected);
  });
});

describe('valorToExtenso', () => {
  it.each([
    [1500, 0, 'mil e quinhentos reais'],
    [3200, 50, 'três mil e duzentos reais e cinquenta centavos'],
    [1, 0, 'um real'],
    [0, 99, 'noventa e nove centavos'],
    [1, 50, 'um real e cinquenta centavos'],
    [0, 1, 'um centavo'],
    [0, 0, 'zero reais'],
    [181848, 55, 'cento e oitenta e um mil oitocentos e quarenta e oito reais e cinquenta e cinco centavos'],
  ])('verbaliza %i reais e %i centavos', (r, c, expected) => {
    expect(valorToExtenso(r, c)).toBe(expected);
  });
});

describe('verbalizeCurrency', () => {
  it('verbaliza moeda com centavos no meio do texto', () => {
    expect(verbalizeCurrency('Seu maior gasto foi R$ 3.200,50 este mês.')).toBe(
      'Seu maior gasto foi três mil e duzentos reais e cinquenta centavos este mês.',
    );
  });

  it('verbaliza valor redondo sem casas decimais', () => {
    expect(verbalizeCurrency('Você tem R$ 1.500 em caixa.')).toBe('Você tem mil e quinhentos reais em caixa.');
  });

  it('não confunde vírgula de pontuação com centavos', () => {
    expect(verbalizeCurrency('Sobrou R$ 1.500, que é pouco.')).toBe('Sobrou mil e quinhentos reais, que é pouco.');
  });

  it('lida com R$ sem espaço', () => {
    expect(verbalizeCurrency('total R$181.848,55 ok')).toBe(
      'total cento e oitenta e um mil oitocentos e quarenta e oito reais e cinquenta e cinco centavos ok',
    );
  });

  it('verbaliza múltiplos valores na mesma frase', () => {
    expect(verbalizeCurrency('R$ 1,00 e R$ 2,00')).toBe('um real e dois reais');
  });
});

describe('stripEmoji', () => {
  it('remove emojis comuns', () => {
    expect(stripEmoji('Maior gasto 💰 foi Moradia 😀').trim()).toBe('Maior gasto foi Moradia');
  });

  it('remove emoji com seletor de variação e ZWJ', () => {
    expect(stripEmoji('ok ❤️ feito').replace(/\s+/g, ' ').trim()).toBe('ok feito');
  });

  it('mantém texto e pontuação normais', () => {
    expect(stripEmoji('R$ 1.500,00 — tudo certo!')).toBe('R$ 1.500,00 — tudo certo!');
  });
});
