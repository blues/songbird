import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatMessage } from './ChatMessage';

vi.mock('@/api/analytics', () => ({
  submitFeedback: vi.fn(),
}));

vi.mock('./QueryVisualization', () => ({
  QueryVisualization: () => <div data-testid="query-viz">Visualization</div>,
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock('@/utils/formatters', () => ({
  formatRelativeTime: vi.fn(() => '2 minutes ago'),
}));

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe('ChatMessage', () => {
  const baseProps = {
    mapboxToken: 'pk.test',
    userEmail: 'user@test.com',
  };

  it('renders user message content in a card', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'user',
          content: 'Show me device temperatures',
          timestamp: Date.now(),
        }}
      />
    );
    expect(screen.getByText('Show me device temperatures')).toBeInTheDocument();
  });

  it('renders assistant message with markdown content', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'assistant',
          content: 'Here are the results',
          timestamp: Date.now(),
        }}
      />
    );
    expect(screen.getByText('Here are the results')).toBeInTheDocument();
  });

  it('shows "View SQL Query" button when result is present', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'assistant',
          content: 'Results found',
          timestamp: Date.now(),
          result: {
            sql: 'SELECT * FROM devices',
            explanation: 'Fetches all devices',
            visualizationType: 'table',
            data: [{ id: 1 }],
            insights: 'All devices returned',
          },
        }}
      />
    );
    expect(screen.getByRole('button', { name: /view sql query/i })).toBeInTheDocument();
  });

  it('does not show SQL button when no result', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'assistant',
          content: 'No data',
          timestamp: Date.now(),
        }}
      />
    );
    expect(screen.queryByRole('button', { name: /sql query/i })).not.toBeInTheDocument();
  });

  it('shows "Loading visualization data..." when isLoadingData is true', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'assistant',
          content: 'Loading...',
          timestamp: Date.now(),
          result: {
            sql: 'SELECT 1',
            explanation: '',
            visualizationType: 'table',
            data: [],
            insights: '',
          },
          isLoadingData: true,
        }}
      />
    );
    expect(screen.getByText('Loading visualization data...')).toBeInTheDocument();
  });

  it('renders QueryVisualization when result has data', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'assistant',
          content: 'Here is the chart',
          timestamp: Date.now(),
          result: {
            sql: 'SELECT * FROM telemetry',
            explanation: 'Gets telemetry',
            visualizationType: 'line_chart',
            data: [{ temp: 25 }],
            insights: 'Temperature is normal',
          },
        }}
      />
    );
    expect(screen.getByTestId('query-viz')).toBeInTheDocument();
  });

  it('shows feedback buttons for assistant messages with results', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'assistant',
          content: 'Results',
          timestamp: Date.now(),
          result: {
            sql: 'SELECT 1',
            explanation: '',
            visualizationType: 'table',
            data: [{ id: 1 }],
            insights: '',
          },
        }}
      />
    );
    expect(screen.getByText('Was this helpful?')).toBeInTheDocument();
  });

  it('does not show feedback for user messages', () => {
    renderWithClient(
      <ChatMessage
        {...baseProps}
        message={{
          type: 'user',
          content: 'A question',
          timestamp: Date.now(),
        }}
      />
    );
    expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument();
  });
});
