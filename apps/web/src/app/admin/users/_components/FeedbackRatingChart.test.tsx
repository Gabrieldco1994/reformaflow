import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeedbackRatingChart } from './FeedbackRatingChart';

describe('FeedbackRatingChart', () => {
  it('calcula média e total só a partir das notas válidas (ignora feedbacks sem rating)', () => {
    render(
      <FeedbackRatingChart
        feedbacks={[{ rating: 5 }, { rating: 5 }, { rating: 3 }, { rating: null }, {}]}
      />,
    );
    expect(screen.getByText(/média 4\.3/)).toBeInTheDocument();
    expect(screen.getByText(/3 avaliações/)).toBeInTheDocument();
  });

  it('mostra estado vazio quando não há nenhuma avaliação', () => {
    render(<FeedbackRatingChart feedbacks={[{ rating: null }, {}]} />);
    expect(screen.getByText('Sem avaliações ainda.')).toBeInTheDocument();
  });
});
