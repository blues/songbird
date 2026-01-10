import { useState, useEffect, useCallback } from 'react';
import { Send, Sparkles, Database, TrendingUp, PanelLeftClose, PanelLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ChatMessage } from '@/components/analytics/ChatMessage';
import { SuggestedQuestions } from '@/components/analytics/SuggestedQuestions';
import { ConversationList } from '@/components/analytics/ConversationList';
import { useChatQuery, useChatHistory, useAnalyticsSession } from '@/hooks/useAnalytics';
import { fetchAuthSession } from 'aws-amplify/auth';
import type { QueryResult } from '@/types/analytics';
import { cn } from '@/lib/utils';

interface AnalyticsProps {
  mapboxToken: string;
}

// Generate a unique session ID
const generateSessionId = () => `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export function Analytics({ mapboxToken }: AnalyticsProps) {
  const [question, setQuestion] = useState('');
  const [sessionId, setSessionId] = useState<string>(() => {
    // Try to restore session from localStorage, otherwise create new
    const stored = localStorage.getItem('analytics-session-id');
    return stored || generateSessionId();
  });
  const [userEmail, setUserEmail] = useState<string>('');
  const [messages, setMessages] = useState<Array<{
    type: 'user' | 'assistant';
    content: string;
    result?: QueryResult;
    timestamp: number;
  }>>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);

  const chatMutation = useChatQuery();
  const { data: historyData } = useChatHistory(userEmail);
  const { data: sessionData, isLoading: isLoadingSession } = useAnalyticsSession(loadedSessionId, userEmail);

  // Persist session ID
  useEffect(() => {
    localStorage.setItem('analytics-session-id', sessionId);
  }, [sessionId]);

  useEffect(() => {
    fetchAuthSession().then((session) => {
      const email = session.tokens?.idToken?.payload?.email as string;
      setUserEmail(email || '');
    });
  }, []);

  // Load selected session
  useEffect(() => {
    if (sessionData?.messages && loadedSessionId) {
      const loadedMessages = sessionData.messages.flatMap((item) => [
        {
          type: 'user' as const,
          content: item.question,
          timestamp: item.timestamp,
        },
        {
          type: 'assistant' as const,
          content: item.insights,
          result: {
            sql: item.sql,
            explanation: item.explanation,
            visualizationType: item.visualization_type as QueryResult['visualizationType'],
            data: [], // Historical data not stored
            insights: item.insights,
          },
          timestamp: item.timestamp + 1,
        },
      ]);
      setMessages(loadedMessages);
      setSessionId(loadedSessionId);
    }
  }, [sessionData, loadedSessionId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || !userEmail) return;

    const userMessage = {
      type: 'user' as const,
      content: question,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setQuestion('');

    try {
      const result = await chatMutation.mutateAsync({
        question,
        sessionId,
        userEmail,
      });

      const assistantMessage = {
        type: 'assistant' as const,
        content: result.insights,
        result,
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error: any) {
      const errorMessage = {
        type: 'assistant' as const,
        content: `Error: ${error.message || 'Failed to process query'}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    }
  };

  const handleSuggestedQuestion = (suggestedQuestion: string) => {
    setQuestion(suggestedQuestion);
  };

  const handleSelectSession = useCallback((selectedSessionId: string) => {
    setLoadedSessionId(selectedSessionId);
  }, []);

  const handleNewConversation = useCallback(() => {
    const newSessionId = generateSessionId();
    setSessionId(newSessionId);
    setLoadedSessionId(null);
    setMessages([]);
    localStorage.setItem('analytics-session-id', newSessionId);
  }, []);

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar */}
      <div
        className={cn(
          'flex-shrink-0 transition-all duration-300 border rounded-lg bg-card overflow-hidden',
          sidebarOpen ? 'w-80' : 'w-0 border-0'
        )}
      >
        {sidebarOpen && (
          <ConversationList
            userEmail={userEmail}
            currentSessionId={loadedSessionId || sessionId}
            onSelectSession={handleSelectSession}
            onNewConversation={handleNewConversation}
          />
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 space-y-6 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              title={sidebarOpen ? 'Hide conversations' : 'Show conversations'}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="h-5 w-5" />
              ) : (
                <PanelLeft className="h-5 w-5" />
              )}
            </Button>
            <div>
              <h1 className="text-3xl font-bold flex items-center gap-2">
                <Sparkles className="h-8 w-8 text-purple-500" />
                Analytics Chat
              </h1>
              <p className="text-muted-foreground mt-1">
                Ask questions about your Songbird devices in natural language
              </p>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Total Queries</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{historyData?.total || 0}</div>
              <p className="text-xs text-muted-foreground">This session: {messages.filter(m => m.type === 'user').length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Active Session</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{Math.floor(messages.length / 2)}</div>
              <p className="text-xs text-muted-foreground">Questions asked</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Powered By</CardTitle>
              <Sparkles className="h-4 w-4 text-purple-500" />
            </CardHeader>
            <CardContent>
              <div className="text-lg font-bold">AWS Bedrock</div>
              <p className="text-xs text-muted-foreground">Claude 3.5 Sonnet</p>
            </CardContent>
          </Card>
        </div>

        {/* Suggested Questions */}
        {messages.length === 0 && (
          <SuggestedQuestions onSelect={handleSuggestedQuestion} />
        )}

        {/* Chat Messages */}
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader>
            <CardTitle>Conversation</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto space-y-4">
            {isLoadingSession ? (
              <div className="flex items-center justify-center h-full">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <div className="animate-spin h-5 w-5 border-2 border-purple-500 border-t-transparent rounded-full" />
                  <span>Loading conversation...</span>
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <Sparkles className="h-16 w-16 text-purple-500 mb-4" />
                <h3 className="text-xl font-semibold mb-2">Start a Conversation</h3>
                <p className="text-muted-foreground max-w-md">
                  Ask me anything about your Songbird devices. I can analyze telemetry,
                  find patterns, detect anomalies, and create visualizations.
                </p>
              </div>
            ) : (
              messages.map((message, index) => (
                <ChatMessage key={index} message={message} mapboxToken={mapboxToken} />
              ))
            )}
            {chatMutation.isPending && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full" />
                <span>Analyzing your question...</span>
              </div>
            )}
          </CardContent>

          {/* Input */}
          <div className="border-t p-4">
            <form onSubmit={handleSubmit} className="flex gap-2">
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask a question about your devices..."
                className="flex-1"
                disabled={chatMutation.isPending}
              />
              <Button
                type="submit"
                disabled={!question.trim() || chatMutation.isPending}
                className="gap-2"
              >
                <Send className="h-4 w-4" />
                Ask
              </Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
