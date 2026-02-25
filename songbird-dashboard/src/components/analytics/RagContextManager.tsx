import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Pencil, Trash2, Loader2, Pin, PinOff, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  listRagDocuments,
  createRagDocument,
  updateRagDocument,
  deleteRagDocument,
  reseedRagDocuments,
  toggleRagDocumentPin,
  listNegativeFeedback,
  deleteNegativeFeedback,
} from '@/api/analytics';
import type { RagDocument } from '@/types/analytics';
import { cn } from '@/lib/utils';

type DocType = 'schema' | 'example' | 'domain';
type FilterType = 'all' | DocType;

const DOC_TYPE_COLORS: Record<DocType, string> = {
  schema: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  example: 'bg-green-500/15 text-green-400 border-green-500/20',
  domain: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
};

function DocTypeBadge({ type }: { type: DocType }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-[11px] font-semibold', DOC_TYPE_COLORS[type])}
    >
      {type}
    </Badge>
  );
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

interface SheetState {
  open: boolean;
  mode: 'add' | 'edit';
  doc?: RagDocument;
}

export function RagContextManager() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FilterType>('all');
  const [sheet, setSheet] = useState<SheetState>({ open: false, mode: 'add' });
  const [deleteTarget, setDeleteTarget] = useState<RagDocument | null>(null);
  const [reseedConfirmOpen, setReseedConfirmOpen] = useState(false);

  // Form state
  const [formDocType, setFormDocType] = useState<DocType>('domain');
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['rag-documents', filter],
    queryFn: () => listRagDocuments(filter === 'all' ? undefined : filter),
  });

  const documents = data?.documents ?? [];
  const counts = {
    all: data?.total ?? 0,
    schema: documents.filter(d => d.doc_type === 'schema').length,
    example: documents.filter(d => d.doc_type === 'example').length,
    domain: documents.filter(d => d.doc_type === 'domain').length,
  };

  const createMutation = useMutation({
    mutationFn: createRagDocument,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
      setSheet({ open: false, mode: 'add' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, doc }: { id: string; doc: { title?: string; content: string } }) =>
      updateRagDocument(id, doc),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
      setSheet({ open: false, mode: 'add' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRagDocument,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rag-documents'] });
      setDeleteTarget(null);
    },
  });

  const reseedMutation = useMutation({
    mutationFn: reseedRagDocuments,
    onSuccess: () => setReseedConfirmOpen(false),
  });

  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => toggleRagDocumentPin(id, pinned),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rag-documents'] }),
  });

  function openAdd() {
    setFormDocType('domain');
    setFormTitle('');
    setFormContent('');
    setSheet({ open: true, mode: 'add' });
  }

  function openEdit(doc: RagDocument) {
    setFormDocType(doc.doc_type);
    setFormTitle(doc.title ?? '');
    setFormContent(doc.content);
    setSheet({ open: true, mode: 'edit', doc });
  }

  async function handleSave() {
    if (!formContent.trim()) return;
    if (sheet.mode === 'add') {
      await createMutation.mutateAsync({
        doc_type: formDocType,
        title: formTitle.trim() || undefined,
        content: formContent.trim(),
      });
    } else if (sheet.doc) {
      await updateMutation.mutateAsync({
        id: sheet.doc.id,
        doc: { title: formTitle.trim() || undefined, content: formContent.trim() },
      });
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const filters: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'schema', label: 'Schema' },
    { key: 'example', label: 'Example' },
    { key: 'domain', label: 'Domain' },
  ];

  return (
    <Tabs defaultValue="documents">
      <TabsList>
        <TabsTrigger value="documents">RAG Documents</TabsTrigger>
        <TabsTrigger value="feedback" className="gap-2">
          <ThumbsDown className="h-3.5 w-3.5" />
          Feedback Review
        </TabsTrigger>
      </TabsList>

      <TabsContent value="feedback" className="mt-4">
        <FeedbackReview />
      </TabsContent>

      <TabsContent value="documents" className="mt-4">
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1">
          {filters.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                filter === f.key
                  ? 'bg-muted border-border text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
              )}
            >
              {f.label}{' '}
              <span className={cn(
                'ml-1 px-1.5 py-0.5 rounded-full text-[10px]',
                filter === f.key ? 'bg-muted-foreground/20' : 'bg-muted/50'
              )}>
                {counts[f.key]}
              </span>
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setReseedConfirmOpen(true)} className="gap-2">
            <RefreshCw className="h-3.5 w-3.5" />
            Re-seed Built-ins
          </Button>
          <Button size="sm" onClick={openAdd} className="gap-2">
            <Plus className="h-3.5 w-3.5" />
            Add Document
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24">Type</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-48">Title</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Content</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24">Updated</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-28">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                  Loading documents...
                </td>
              </tr>
            ) : documents.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground text-sm">
                  No documents found. Add one or re-seed the built-ins.
                </td>
              </tr>
            ) : (
              documents.map(doc => (
                <tr key={doc.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <DocTypeBadge type={doc.doc_type} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-foreground">{doc.title || '—'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground line-clamp-2 max-w-md leading-relaxed">
                      {doc.content}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatRelativeTime(doc.updated_at)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn(
                          'h-7 w-7',
                          doc.pinned
                            ? 'text-amber-400 hover:text-amber-500'
                            : 'text-muted-foreground hover:text-amber-400'
                        )}
                        title={doc.pinned ? 'Unpin (always included)' : 'Pin (always include in context)'}
                        onClick={() => pinMutation.mutate({ id: doc.id, pinned: !doc.pinned })}
                      >
                        {doc.pinned ? <Pin className="h-3.5 w-3.5 fill-current" /> : <PinOff className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={() => openEdit(doc)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(doc)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Sheet */}
      <Sheet open={sheet.open} onOpenChange={open => setSheet(s => ({ ...s, open }))}>
        <SheetContent className="w-[480px] sm:max-w-[480px] flex flex-col">
          <SheetHeader>
            <SheetTitle>{sheet.mode === 'add' ? 'Add Document' : 'Edit Document'}</SheetTitle>
            <SheetDescription>
              {sheet.mode === 'add'
                ? 'Add a new document to the RAG context corpus. It will be embedded automatically.'
                : 'Update the document content. The embedding will be regenerated on save.'}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto py-4 space-y-5">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={formDocType} onValueChange={v => setFormDocType(v as DocType)} disabled={sheet.mode === 'edit'}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="schema">schema — table/column descriptions</SelectItem>
                  <SelectItem value="example">example — Q→SQL pairs</SelectItem>
                  <SelectItem value="domain">domain — Songbird concepts</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                schema = table info · example = Q→SQL pair · domain = Songbird knowledge
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input
                value={formTitle}
                onChange={e => setFormTitle(e.target.value)}
                placeholder="e.g. Wi-Fi Credentials"
              />
              <p className="text-xs text-muted-foreground">
                Used as a unique identifier. Must be unique across all documents.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Content</Label>
              <textarea
                value={formContent}
                onChange={e => setFormContent(e.target.value)}
                placeholder="Enter document content..."
                className="w-full min-h-[280px] rounded-md border border-input bg-background px-3 py-2 text-xs font-mono text-foreground resize-y focus:outline-none focus:ring-2 focus:ring-ring leading-relaxed"
              />
              <p className="text-xs text-muted-foreground">
                This text will be embedded and used for similarity search. Be specific and detailed.
              </p>
            </div>
          </div>

          <SheetFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => setSheet(s => ({ ...s, open: false }))}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving || !formContent.trim()} className="gap-2">
              {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save &amp; Embed
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.title || 'This document'}" will be permanently removed from the RAG corpus
              and will no longer be retrieved for SQL generation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Re-seed Confirmation */}
      <AlertDialog open={reseedConfirmOpen} onOpenChange={setReseedConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-seed built-in documents?</AlertDialogTitle>
            <AlertDialogDescription>
              This will refresh all 17 built-in schema, example, and domain documents from the source code.
              Any custom documents you've added will not be affected. The process takes ~30 seconds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => reseedMutation.mutate()}
              disabled={reseedMutation.isPending}
            >
              {reseedMutation.isPending ? 'Starting...' : 'Re-seed'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
      </TabsContent>
    </Tabs>
  );
}

function FeedbackReview() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['negative-feedback'],
    queryFn: () => listNegativeFeedback(100),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ userEmail, ratedAt }: { userEmail: string; ratedAt: number }) =>
      deleteNegativeFeedback(userEmail, ratedAt),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['negative-feedback'] }),
  });

  const items = data?.items ?? [];

  function formatDate(ts: number) {
    return new Date(ts).toLocaleString();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Negative feedback from users — use this to improve prompts or add better examples to the RAG corpus.
        </p>
        <span className="text-xs text-muted-foreground">{items.length} items</span>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">User</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Question</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-48">Comment</th>
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-36">Date</th>
              <th className="px-4 py-2.5 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                  Loading feedback...
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground text-sm">
                  No negative feedback yet.
                </td>
              </tr>
            ) : (
              items.map((item, i) => (
                <tr key={i} className="border-t border-border hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground">{item.userEmail}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-foreground line-clamp-2">{item.question}</div>
                    <details className="mt-1">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">View SQL</summary>
                      <pre className="text-xs text-muted-foreground mt-1 overflow-x-auto whitespace-pre-wrap font-mono bg-muted/30 rounded p-2">{item.sql}</pre>
                    </details>
                  </td>
                  <td className="px-4 py-3">
                    {item.comment ? (
                      <div className="text-sm text-foreground">{item.comment}</div>
                    ) : (
                      <div className="text-xs text-muted-foreground italic">No comment</div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(item.ratedAt)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMutation.mutate({ userEmail: item.userEmail, ratedAt: item.ratedAt })}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
