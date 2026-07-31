import {
  extractReceiptJson,
  normalizeReceiptScan,
  toCents,
  toIsoDate,
  toText,
} from './receipt-scan.parser';

/**
 * Testa a NORMALIZAÇÃO — a parte que decide o que vira dinheiro na tela.
 * A chamada de rede é coberta pelo caminho de erro do controller; aqui o alvo é
 * o que a IA devolve virar (ou não virar) um valor confiável.
 */
describe('receipt-scan parser', () => {
  describe('toCents', () => {
    it('lê "123.45" (ponto decimal) como 12345 centavos', () => {
      expect(toCents('123.45')).toBe(12345);
    });

    it('lê "1.234,56" (formato pt-BR, milhar com ponto) como 123456 centavos', () => {
      // Cupom brasileiro imprime assim; ler como 1.23 perderia 3 ordens de grandeza.
      expect(toCents('1.234,56')).toBe(123456);
    });

    it('lê "1234,56" (vírgula decimal sem milhar)', () => {
      expect(toCents('1234,56')).toBe(123456);
    });

    it('lê "1,234.56" (formato en-US) sem inflar o valor', () => {
      expect(toCents('1,234.56')).toBe(123456);
    });

    it('ignora símbolo de moeda e espaços', () => {
      expect(toCents('R$ 89,90')).toBe(8990);
    });

    it('aceita número puro', () => {
      expect(toCents(52.3)).toBe(5230);
    });

    it('devolve null para valor ausente, zero ou negativo — nunca inventa dinheiro', () => {
      expect(toCents(null)).toBeNull();
      expect(toCents('')).toBeNull();
      expect(toCents('abc')).toBeNull();
      expect(toCents(0)).toBeNull();
      expect(toCents('-10')).toBeNull();
      expect(toCents(undefined)).toBeNull();
    });
  });

  describe('toIsoDate', () => {
    it('aceita ISO direto', () => {
      expect(toIsoDate('2026-07-31')).toBe('2026-07-31');
    });

    it('converte DD/MM/AAAA (formato da maioria dos cupons)', () => {
      expect(toIsoDate('31/07/2026')).toBe('2026-07-31');
    });

    it('devolve null para data ilegível em vez de chutar', () => {
      expect(toIsoDate('ontem')).toBeNull();
      expect(toIsoDate(null)).toBeNull();
      expect(toIsoDate('31-07-2026')).toBeNull();
    });
  });

  describe('toText', () => {
    it('trata a string "null" como ausência — a IA às vezes devolve isso literalmente', () => {
      expect(toText('null')).toBeNull();
      expect(toText('NULL')).toBeNull();
    });

    it('corta texto muito longo para não estourar o campo', () => {
      expect(toText('x'.repeat(300))?.length).toBe(120);
    });

    it('devolve null para string vazia ou só espaços', () => {
      expect(toText('   ')).toBeNull();
      expect(toText('')).toBeNull();
    });
  });

  describe('extractReceiptJson', () => {
    it('extrai JSON puro', () => {
      expect(extractReceiptJson('{"valor":"10.00"}')).toEqual({ valor: '10.00' });
    });

    it('extrai JSON dentro de cerca markdown (o modelo às vezes envolve)', () => {
      expect(extractReceiptJson('```json\n{"valor":"10.00"}\n```')).toEqual({ valor: '10.00' });
    });

    it('extrai JSON com texto solto em volta', () => {
      expect(extractReceiptJson('Aqui está: {"valor":"10.00"} pronto')).toEqual({ valor: '10.00' });
    });

    it('devolve null quando não há JSON válido', () => {
      expect(extractReceiptJson('não consegui ler')).toBeNull();
      expect(extractReceiptJson('{quebrado')).toBeNull();
    });
  });

  describe('normalizeReceiptScan', () => {
    it('monta o resultado completo a partir do JSON da IA', () => {
      expect(
        normalizeReceiptScan({
          valor: '89,90',
          fornecedor: 'Padaria Central',
          descricao: 'pães e leite',
          data: '31/07/2026',
        }),
      ).toEqual({
        valorCents: 8990,
        fornecedor: 'Padaria Central',
        descricao: 'pães e leite',
        data: '2026-07-31',
      });
    });

    it('imagem que não é comprovante vira resultado vazio, não erro', () => {
      // O usuário cai no modal com os campos em branco e digita — melhor que
      // um erro que descarta a foto e obriga a refazer.
      expect(
        normalizeReceiptScan({ valor: null, fornecedor: null, descricao: null, data: null }),
      ).toEqual({ valorCents: null, fornecedor: null, descricao: null, data: null });
    });

    it('JSON ausente (parse falhou) vira resultado vazio', () => {
      expect(normalizeReceiptScan(null)).toEqual({
        valorCents: null,
        fornecedor: null,
        descricao: null,
        data: null,
      });
    });

    it('campo ilegível não contamina os demais', () => {
      // Valor legível + data ilegível tem que preservar o valor: obrigar a
      // redigitar tudo por causa de um campo seria pior que o OCR não existir.
      expect(
        normalizeReceiptScan({ valor: '50.00', fornecedor: 'Posto', descricao: null, data: 'ilegível' }),
      ).toEqual({
        valorCents: 5000,
        fornecedor: 'Posto',
        descricao: null,
        data: null,
      });
    });
  });
});
