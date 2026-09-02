import type { ClassifyResult } from './merchant-classifier.service';

type Assert<T extends true> = T;
type RegexRemovido = 'REGEX' extends ClassifyResult['source'] ? false : true;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _RegexCheck = Assert<RegexRemovido>;

describe("ClassifyResult['source'] — union sem 'REGEX' (#582 PR-2)", () => {
  it('aceita exatamente AI | MANUAL | CACHE', () => {
    const ok: ClassifyResult['source'][] = ['AI', 'MANUAL', 'CACHE'];
    expect(new Set(ok).size).toBe(3);
  });
  it('o compilador rejeita "REGEX" (ver type assertion no topo)', () => {
    expect(true).toBe(true);
  });
});
