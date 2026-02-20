import { User, Sparkles, Code, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import Markdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { QueryVisualization } from './QueryVisualization';
import { formatRelativeTime } from '@/utils/formatters';
import type { QueryResult } from '@/types/analytics';

interface ChatMessageProps {
  message: {
    type: 'user' | 'assistant';
    content: string;
    result?: QueryResult;
    timestamp: number;
    isLoadingData?: boolean;
  };
  mapboxToken: string;
}

export function ChatMessage({ message, mapboxToken }: ChatMessageProps) {
  const [showSQL, setShowSQL] = useState(false);

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
      </div>
    </div>
  );
}