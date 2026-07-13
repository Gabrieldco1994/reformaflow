import { describe, expect, it } from 'vitest';
import { detectVerdict } from './verdict';

describe('detectVerdict', () => {
  it('detecta veredito positivo quando a resposta começa afirmando', () => {
    const v = detectVerdict('Posso gastar R$ 500?', 'Pode — mas por pouco. Julho fecha em -R$ 2,4 mil.');
    expect(v).toEqual({ tone: 'good' });
  });

  it('detecta veredito negativo quando a resposta começa negando', () => {
    const v = detectVerdict('Posso gastar R$ 500?', 'Não, isso estoura o colchão de agosto.');
    expect(v).toEqual({ tone: 'bad' });
  });

  it('retorna null se a pergunta não é do tipo "posso gastar"', () => {
    const v = detectVerdict('Quanto gastei com mercado?', 'Pode — R$ 480 em julho.');
    expect(v).toBeNull();
  });

  it('retorna null se a resposta não começa com sinal inequívoco (fallback pra texto)', () => {
    const v = detectVerdict('Posso gastar R$ 500?', 'Depende do que mais você tem planejado este mês.');
    expect(v).toBeNull();
  });
});
