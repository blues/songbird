import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JourneySelector } from './JourneySelector';
import type { Journey } from '@/types';

vi.mock('@/contexts/PreferencesContext', () => ({
  usePreferences: vi.fn(() => ({
    preferences: { distance_unit: 'km' },
    isLoading: false,
  })),
}));

vi.mock('@/utils/formatters', () => ({
  formatRelativeTime: vi.fn(() => '5 min ago'),
}));

const mockJourney: Journey = {
  journey_id: 1001,
  device_uid: 'dev:1234',
  status: 'completed',
  start_time: '2025-01-15T10:00:00Z',
  end_time: '2025-01-15T12:30:00Z',
  point_count: 45,
  total_distance: 15000,
};

const activeJourney: Journey = {
  journey_id: 1002,
  device_uid: 'dev:1234',
  status: 'active',
  start_time: '2025-01-15T14:00:00Z',
  point_count: 10,
  total_distance: 3000,
};

describe('JourneySelector', () => {
  it('shows "Loading journeys..." when isLoading', () => {
    render(
      <JourneySelector
        journeys={[]}
        selectedJourneyId={null}
        onSelect={vi.fn()}
        isLoading
      />
    );
    expect(screen.getByText('Loading journeys...')).toBeInTheDocument();
  });

  it('shows "No journeys recorded" when journeys is empty', () => {
    render(
      <JourneySelector
        journeys={[]}
        selectedJourneyId={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('No journeys recorded')).toBeInTheDocument();
  });

  it('renders journey with date and "Completed" badge', () => {
    render(
      <JourneySelector
        journeys={[mockJourney]}
        selectedJourneyId={null}
        onSelect={vi.fn()}
      />
    );
    // The component renders the date in multiple layout variants; check that at least one "Completed" badge is present
    const badges = screen.getAllByText('Completed');
    expect(badges.length).toBeGreaterThan(0);
    // Check that start date text is rendered (compact layout uses short month + day)
    expect(screen.getAllByText(/Jan/).length).toBeGreaterThan(0);
  });

  it('shows "Active" badge for active journey', () => {
    render(
      <JourneySelector
        journeys={[activeJourney]}
        selectedJourneyId={null}
        onSelect={vi.fn()}
      />
    );
    const badges = screen.getAllByText('Active');
    expect(badges.length).toBeGreaterThan(0);
  });

  it('calls onSelect when journey is clicked', () => {
    const onSelect = vi.fn();

    render(
      <JourneySelector
        journeys={[mockJourney]}
        selectedJourneyId={null}
        onSelect={onSelect}
      />
    );

    const badges = screen.getAllByText('Completed');
    fireEvent.click(badges[0].closest('[class*="cursor-pointer"]')!);
    expect(onSelect).toHaveBeenCalledWith(1001);
  });

  it('shows delete button only when canDelete=true and journey is completed', () => {
    const { container } = render(
      <JourneySelector
        journeys={[mockJourney]}
        selectedJourneyId={null}
        onSelect={vi.fn()}
        canDelete
        onDelete={vi.fn()}
      />
    );
    // Trash2 icon renders with class "lucide lucide-trash2"
    const trashButtons = container.querySelectorAll('svg.lucide-trash2');
    expect(trashButtons.length).toBeGreaterThan(0);
  });

  it('does not show delete button for active journeys', () => {
    const { container } = render(
      <JourneySelector
        journeys={[activeJourney]}
        selectedJourneyId={null}
        onSelect={vi.fn()}
        canDelete
        onDelete={vi.fn()}
      />
    );
    const trashButtons = container.querySelectorAll('svg.lucide-trash-2');
    expect(trashButtons.length).toBe(0);
  });

  it('highlights selected journey with border-primary class', () => {
    render(
      <JourneySelector
        journeys={[mockJourney]}
        selectedJourneyId={1001}
        onSelect={vi.fn()}
      />
    );

    const badges = screen.getAllByText('Completed');
    const journeyDiv = badges[0].closest('[class*="cursor-pointer"]');
    expect(journeyDiv?.className).toContain('border-primary');
  });
});
