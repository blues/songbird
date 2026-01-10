/**
 * ConversationList Component
 *
 * Displays a list of past analytics chat sessions with load/delete actions.
 */

import { useState } from 'react';
import { MessageSquare, Trash2, Clock, ChevronRight, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAnalyticsSessions, useDeleteSession } from '@/hooks/useAnalytics';
import type { SessionSummary } from '@/types/analytics';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

interface ConversationListProps {
  userEmail: string;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewConversation: () => void;
}

export function ConversationList({
  userEmail,
  currentSessionId,
  onSelectSession,
  onNewConversation,
}: ConversationListProps) {
  const { data, isLoading } = useAnalyticsSessions(userEmail);
  const deleteSession = useDeleteSession();
  const [sessionToDelete, setSessionToDelete] = useState<SessionSummary | null>(null);

  const handleDelete = async () => {
    if (!sessionToDelete) return;

    try {
      await deleteSession.mutateAsync({
        sessionId: sessionToDelete.sessionId,
        userEmail,
      });
      setSessionToDelete(null);
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const formatTimestamp = (timestamp: number) => {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  };

  const truncateQuestion = (question: string, maxLength = 60) => {
    if (question.length <= maxLength) return question;
    return question.slice(0, maxLength).trim() + '...';
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b">
        <Button
          onClick={onNewConversation}
          className="w-full"
          variant="outline"
        >
          <Plus className="h-4 w-4 mr-2" />
          New Conversation
        </Button>
      </div>

      {/* Sessions List */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !data?.sessions || data.sessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No conversations yet</p>
              <p className="text-xs mt-1">Start a new conversation to begin</p>
            </div>
          ) : (
            data.sessions.map((session) => (
              <div
                key={session.sessionId}
                className={cn(
                  'group relative rounded-lg border p-3 cursor-pointer transition-colors',
                  currentSessionId === session.sessionId
                    ? 'bg-primary/10 border-primary'
                    : 'hover:bg-muted/50'
                )}
                onClick={() => onSelectSession(session.sessionId)}
              >
                <div className="pr-8">
                  <p className="text-sm font-medium line-clamp-2">
                    {truncateQuestion(session.firstQuestion)}
                  </p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>{formatTimestamp(session.lastTimestamp)}</span>
                    <span>·</span>
                    <span>{session.messageCount} message{session.messageCount !== 1 ? 's' : ''}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSessionToDelete(session);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!sessionToDelete} onOpenChange={() => setSessionToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this conversation and all its messages.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteSession.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
