import { User, Sparkles, Code, Eye, EyeOff, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { QueryVisualization } from './QueryVisualization';
import { formatRelativeTime } from '@/utils/formatters';
import { submitFeedback } from '@/api/analytics';
import type { QueryResult } from '@/types/analytics';
import { cn } from '@/lib/utils';

interface ChatMessageProps {
  message: {
    type: 'user' | 'assistant';
    content: string;
    result?: QueryResult;
    timestamp: number;
    isLoadingData?: boolean;
  };
  mapboxToken: string;
  userEmail: string;
}

export function ChatMessage({ message, mapboxToken, userEmail }: ChatMessageProps) {
  const [showSQL, setShowSQL] = useState(false);
  const [rating, setRating] = useState<'positive' | 'negative' | null>(null);
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [comment, setComment] = useState('');

  const feedbackMutation = useMutation({
    mutationFn: submitFeedback,
    onSuccess: () => {
      setShowFeedbackForm(false);
      setComment('');
    },
  });

  // Use the exact DynamoDB timestamp from the saved record; fall back to message timestamp
  const feedbackTimestamp = message.result?.savedTimestamp ?? message.timestamp;

  function handleThumbsUp() {
    if (rating || !message.result) return;
    setRating('positive');
    feedbackMutation.mutate({
      userEmail,
      timestamp: feedbackTimestamp,
      rating: 'positive',
      question: message.content,
      sql: message.result.sql,
      visualizationType: message.result.visualizationType,
    });
  }

  function handleThumbsDown() {
    if (rating || !message.result) return;
    setRating('negative');
    setShowFeedbackForm(true);
  }

  function submitNegativeFeedback() {
    if (!message.result) return;
    feedbackMutation.mutate({
      userEmail,
      timestamp: feedbackTimestamp,
      rating: 'negative',
      question: message.content,
      sql: message.result.sql,
      comment: comment.trim() || undefined,
    });
  }

  if (message.type === 'user') {
    return (
      <div className="flex gap-3 justify-end">
        <Card className="bg-primary text-primary-foreground p-4 max-w-[80%]">
          <p className="whitespace-pre-wrap">{message.content}</p>
          <p className="text-xs opacity-70 mt-2">
            {formatRelativeTime(new Date(message.timestamp))}
          </p>
        </Card>
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center">
          <User className="h-4 w-4 text-primary-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center">
        <Sparkles className="h-4 w-4 text-white" />
      </div>
      <div className="flex-1 space-y-3 max-w-[80%]">
        {/* Insights */}
        <Card className="p-4 bg-muted/50">
          <div className="prose prose-sm max-w-none dark:prose-invert">
            <Markdown>{message.content}</Markdown>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            {formatRelativeTime(new Date(message.timestamp))}
          </p>
        </Card>

        {/* Visualization */}
        {message.result && message.isLoadingData && (
          <Card className="p-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="animate-spin h-4 w-4 border-2 border-purple-500 border-t-transparent rounded-full" />
              <span>Loading visualization data...</span>
            </div>
          </Card>
        )}
        {message.result && !message.isLoadingData && message.result.data && message.result.data.length > 0 && (
          <Card className="p-4">
            <QueryVisualization result={message.result} mapboxToken={mapboxToken} />
          </Card>
        )}

        {/* SQL Toggle */}
        {message.result && (
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSQL(!showSQL)}
              className="gap-2"
            >
              {showSQL ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showSQL ? 'Hide' : 'View'} SQL Query
            </Button>

            {showSQL && (
              <Card className="p-4 bg-slate-950">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Code className="h-4 w-4 text-slate-400" />
                    <span className="text-xs font-mono text-slate-400">SQL Query</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(message.result!.sql);
                    }}
                    className="h-6 px-2 text-xs"
                  >
                    Copy
                  </Button>
                </div>
                <pre className="text-sm text-slate-300 overflow-x-auto">
                  <code>{message.result.sql}</code>
                </pre>
                {message.result.explanation && (
                  <p className="text-xs text-slate-400 mt-3 border-t border-slate-800 pt-3">
                    {message.result.explanation}
                  </p>
                )}
              </Card>
            )}
          </div>
        )}

        {/* Feedback */}
        {message.result && !message.isLoadingData && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Was this helpful?</span>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-7 w-7',
                  rating === 'positive' ? 'text-green-500' : 'text-muted-foreground',
                  rating && rating !== 'positive' && 'opacity-30 cursor-default'
                )}
                onClick={handleThumbsUp}
                disabled={!!rating}
              >
                <ThumbsUp className={cn('h-3.5 w-3.5', rating === 'positive' && 'fill-current')} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'h-7 w-7',
                  rating === 'negative' ? 'text-red-400' : 'text-muted-foreground',
                  rating && rating !== 'negative' && 'opacity-30 cursor-default'
                )}
                onClick={handleThumbsDown}
                disabled={!!rating}
              >
                <ThumbsDown className={cn('h-3.5 w-3.5', rating === 'negative' && 'fill-current')} />
              </Button>
            </div>

            {/* Positive confirmation */}
            {rating === 'positive' && (
              <p className="text-xs text-green-500 flex items-center gap-1">
                <span>✓</span> Saved to improve future results
              </p>
            )}

            {/* Negative feedback form */}
            {showFeedbackForm && (
              <div className="space-y-2 p-3 rounded-lg border bg-muted/20">
                <Input
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                  placeholder="What was wrong? (optional)"
                  className="text-xs h-8"
                  onKeyDown={e => e.key === 'Enter' && submitNegativeFeedback()}
                />
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs" onClick={submitNegativeFeedback} disabled={feedbackMutation.isPending}>
                    Submit
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setShowFeedbackForm(false); setRating(null); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Negative confirmation */}
            {rating === 'negative' && !showFeedbackForm && (
              <p className="text-xs text-muted-foreground">Thanks for the feedback.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}