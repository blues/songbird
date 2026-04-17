import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConversationList } from './ConversationList';
import type { SessionSummary } from '@/types/analytics';

vi.mock('@/hooks/useAnalytics', () => ({
  useAnalyticsSessions: vi.fn(),
  useDeleteSession: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '5 minutes ago'),
}));

const { useAnalyticsSessions } = await import('@/hooks/useAnalytics');

beforeEach(() => {
  vi.mocked(useAnalyticsSessions).mockReturnValue({
    data: undefined,
    isLoading: false,
  } as any);
});

describe('ConversationList', () => {
  const defaultProps = {
    userEmail: 'user@test.com',
    currentSessionId: null,
    onSelectSession: vi.fn(),
    onNewConversation: vi.fn(),
  };

  it('renders "New Conversation" button', () => {
    render(<ConversationList {...defaultProps} />);
    expect(screen.getByRole('button', { name: /new conversation/i })).toBeInTheDocument();
  });

  it('calls onNewConversation when button is clicked', () => {
    const onNewConversation = vi.fn();
    render(<ConversationList {...defaultProps} onNewConversation={onNewConversation} />);

    fireEvent.click(screen.getByRole('button', { name: /new conversation/i }));
    expect(onNewConversation).toHaveBeenCalledOnce();
  });

  it('shows loading spinner when isLoading', () => {
    vi.mocked(useAnalyticsSessions).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as any);

    const { container } = render(<ConversationList {...defaultProps} />);
    // Loader2 renders an svg with animate-spin class
    const spinner = container.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows "No conversations yet" when sessions list is empty', () => {
    vi.mocked(useAnalyticsSessions).mockReturnValue({
      data: { sessions: [], total: 0 },
      isLoading: false,
    } as any);

    render(<ConversationList {...defaultProps} />);
    expect(screen.getByText('No conversations yet')).toBeInTheDocument();
  });

  it('renders session items with truncated question text', () => {
    const sessions: SessionSummary[] = [
      {
        sessionId: 'sess-1',
        firstQuestion: 'What is the average temperature across all devices in the fleet over the past week of operation?',
        lastQuestion: 'follow up',
        startTimestamp: Date.now() - 60000,
        lastTimestamp: Date.now(),
        messageCount: 3,
      },
    ];

    vi.mocked(useAnalyticsSessions).mockReturnValue({
      data: { sessions, total: 1 },
      isLoading: false,
    } as any);

    render(<ConversationList {...defaultProps} />);
    // Truncated to 60 chars + "..."
    expect(screen.getByText(/What is the average temperature across all devices in the fl.../)).toBeInTheDocument();
    expect(screen.getByText('3 messages')).toBeInTheDocument();
  });

  it('highlights current session', () => {
    const sessions: SessionSummary[] = [
      {
        sessionId: 'sess-1',
        firstQuestion: 'Question 1',
        lastQuestion: 'Question 1',
        startTimestamp: Date.now(),
        lastTimestamp: Date.now(),
        messageCount: 1,
      },
    ];

    vi.mocked(useAnalyticsSessions).mockReturnValue({
      data: { sessions, total: 1 },
      isLoading: false,
    } as any);

    const { container } = render(
      <ConversationList {...defaultProps} currentSessionId="sess-1" />
    );
    // The active session gets bg-primary/10 and border-primary classes
    const sessionEl = container.querySelector('.border-primary');
    expect(sessionEl).toBeInTheDocument();
  });

  it('calls onSelectSession when a session is clicked', () => {
    const onSelectSession = vi.fn();
    const sessions: SessionSummary[] = [
      {
        sessionId: 'sess-42',
        firstQuestion: 'My question',
        lastQuestion: 'My question',
        startTimestamp: Date.now(),
        lastTimestamp: Date.now(),
        messageCount: 1,
      },
    ];

    vi.mocked(useAnalyticsSessions).mockReturnValue({
      data: { sessions, total: 1 },
      isLoading: false,
    } as any);

    render(<ConversationList {...defaultProps} onSelectSession={onSelectSession} />);
    fireEvent.click(screen.getByText('My question'));
    expect(onSelectSession).toHaveBeenCalledWith('sess-42');
  });
});
