import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestedQuestions } from './SuggestedQuestions';

describe('SuggestedQuestions', () => {
  it('renders all 6 suggested questions', () => {
    render(<SuggestedQuestions onSelect={vi.fn()} />);
    const cards = screen.getAllByRole('paragraph');
    expect(cards).toHaveLength(6);
  });

  it('renders "Suggested Questions" heading', () => {
    render(<SuggestedQuestions onSelect={vi.fn()} />);
    expect(screen.getByText('Suggested Questions')).toBeInTheDocument();
  });

  it('calls onSelect with the question text when a card is clicked', () => {
    const handleSelect = vi.fn();
    render(<SuggestedQuestions onSelect={handleSelect} />);

    const questionText = 'What devices have alerted the most in the last month?';
    fireEvent.click(screen.getByText(questionText));
    expect(handleSelect).toHaveBeenCalledWith(questionText);
  });

  it('each question card contains the expected text', () => {
    render(<SuggestedQuestions onSelect={vi.fn()} />);
    expect(screen.getByText('Give me the last ten unique locations where my devices have reported a location')).toBeInTheDocument();
    expect(screen.getByText('Do you see any out of variance telemetry readings in the last 30 days?')).toBeInTheDocument();
    expect(screen.getByText('Show me a graph of power usage across all of the journeys for my devices')).toBeInTheDocument();
    expect(screen.getByText('Show me all devices and highlight the highest and lowest temperature readings over the last month')).toBeInTheDocument();
    expect(screen.getByText('What devices have alerted the most in the last month?')).toBeInTheDocument();
    expect(screen.getByText('Show me temperature trends for all my devices over the last 7 days')).toBeInTheDocument();
  });
});
