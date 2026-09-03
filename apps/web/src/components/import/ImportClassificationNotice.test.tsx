import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportClassificationNotice, CategoriaFonteChip } from './ImportClassificationNotice';

describe('ImportClassificationNotice', () => {
  it('unavailable → banner de indisponibilidade, pedindo revisão', () => {
    render(<ImportClassificationNotice status="unavailable" />);
    expect(
      screen.getByText(/categorização automática está indisponível/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/revise as categorias sugeridas/i)).toBeInTheDocument();
  });

  it('error → banner de "não concluída", pedindo revisão', () => {
    render(<ImportClassificationNotice status="error" />);
    expect(
      screen.getByText(/categorização automática não foi concluída/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/revise as categorias sugeridas/i)).toBeInTheDocument();
  });

  it('ok → não renderiza nada', () => {
    const { container } = render(<ImportClassificationNotice status="ok" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('status ausente → não renderiza nada', () => {
    const { container } = render(<ImportClassificationNotice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('copy neutra: não menciona "IA" nem "Maria"', () => {
    const { container: a } = render(<ImportClassificationNotice status="unavailable" />);
    const { container: b } = render(<ImportClassificationNotice status="error" />);
    expect(`${a.textContent} ${b.textContent}`).not.toMatch(/\bIA\b|Maria/);
  });
});

describe('CategoriaFonteChip', () => {
  it.each([
    ['regra', 'Regra'],
    ['ia', 'IA'],
    ['regex', 'Sugestão automática'],
  ] as const)('fonte %s → chip "%s"', (fonte, label) => {
    render(<CategoriaFonteChip fonte={fonte} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('fonte null → sem chip', () => {
    const { container } = render(<CategoriaFonteChip fonte={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fonte indefinida → sem chip', () => {
    const { container } = render(<CategoriaFonteChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('valor desconhecido → sem chip (não renderiza rótulo cru)', () => {
    const { container } = render(
      <CategoriaFonteChip fonte={'futuro' as never} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
