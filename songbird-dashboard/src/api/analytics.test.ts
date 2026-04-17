import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./client', () => ({
  apiFetch: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiFetch, apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client';
import {
  chatQuery,
  getChatHistory,
  listSessions,
  getSession,
  deleteSession,
  listRagDocuments,
  createRagDocument,
  updateRagDocument,
  deleteRagDocument,
  toggleRagDocumentPin,
  reseedRagDocuments,
  rerunQuery,
  submitFeedback,
  listNegativeFeedback,
  deleteNegativeFeedback,
} from './analytics';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chatQuery', () => {
  it('delegates to apiPost and returns the result', async () => {
    const expected = { sql: 'SELECT 1', data: [] };
    vi.mocked(apiPost).mockResolvedValueOnce(expected);

    const result = await chatQuery({ query: 'how many devices?' } as any);

    expect(apiPost).toHaveBeenCalledWith('/analytics/chat', { query: 'how many devices?' });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPost', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('Internal error'));

    await expect(chatQuery({ query: 'fail' } as any)).rejects.toThrow('Internal error');
  });
});

describe('getChatHistory', () => {
  it('fetches chat history with default limit', async () => {
    const expected = { items: [] };
    vi.mocked(apiGet).mockResolvedValueOnce(expected);

    const result = await getChatHistory('user@test.com');

    expect(apiGet).toHaveBeenCalledWith('/analytics/history', {
      userEmail: 'user@test.com',
      limit: 50,
    });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiGet', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('Failed to fetch chat history: 403'));

    await expect(getChatHistory('user@test.com')).rejects.toThrow('Failed to fetch chat history: 403');
  });
});

describe('listSessions', () => {
  it('fetches sessions with custom limit', async () => {
    const expected = { sessions: [] };
    vi.mocked(apiGet).mockResolvedValueOnce(expected);

    const result = await listSessions('user@test.com', 10);

    expect(apiGet).toHaveBeenCalledWith('/analytics/sessions', {
      userEmail: 'user@test.com',
      limit: 10,
    });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiGet', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('Failed to fetch sessions: 500'));

    await expect(listSessions('user@test.com')).rejects.toThrow('Failed to fetch sessions: 500');
  });
});

describe('getSession', () => {
  it('fetches a specific session with an encoded id', async () => {
    const expected = { session: { id: 'sess-1' } };
    vi.mocked(apiGet).mockResolvedValueOnce(expected);

    const result = await getSession('sess-1', 'user@test.com');

    expect(apiGet).toHaveBeenCalledWith('/analytics/sessions/sess-1', {
      userEmail: 'user@test.com',
    });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiGet', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('Failed to fetch session: 404'));

    await expect(getSession('sess-1', 'user@test.com')).rejects.toThrow('Failed to fetch session: 404');
  });
});

describe('deleteSession', () => {
  it('calls apiDelete with an encoded session id and userEmail query', async () => {
    vi.mocked(apiDelete).mockResolvedValueOnce(undefined);

    await deleteSession('sess-1', 'user@test.com');

    expect(apiDelete).toHaveBeenCalledWith('/analytics/sessions/sess-1?userEmail=user%40test.com');
  });

  it('propagates errors from apiDelete', async () => {
    vi.mocked(apiDelete).mockRejectedValueOnce(new Error('Delete failed'));

    await expect(deleteSession('sess-1', 'user@test.com')).rejects.toThrow('Delete failed');
  });
});

describe('listRagDocuments', () => {
  it('fetches all RAG documents without docType', async () => {
    const expected = { documents: [] };
    vi.mocked(apiGet).mockResolvedValueOnce(expected);

    const result = await listRagDocuments();

    expect(apiGet).toHaveBeenCalledWith('/analytics/rag-documents', undefined);
    expect(result).toEqual(expected);
  });

  it('fetches RAG documents filtered by docType', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ documents: [] });

    await listRagDocuments('schema');

    expect(apiGet).toHaveBeenCalledWith('/analytics/rag-documents', { doc_type: 'schema' });
  });

  it('propagates errors from apiGet', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('Failed to fetch RAG documents: 500'));

    await expect(listRagDocuments()).rejects.toThrow('Failed to fetch RAG documents: 500');
  });
});

describe('createRagDocument', () => {
  it('sends a POST request to create a document', async () => {
    const doc = { doc_type: 'schema' as const, content: 'table info' };
    const expected = { document: { id: 'doc-1', ...doc } };
    vi.mocked(apiPost).mockResolvedValueOnce(expected);

    const result = await createRagDocument(doc);

    expect(apiPost).toHaveBeenCalledWith('/analytics/rag-documents', doc);
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPost', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('Invalid doc'));

    await expect(createRagDocument({ doc_type: 'schema', content: '' })).rejects.toThrow('Invalid doc');
  });
});

describe('updateRagDocument', () => {
  it('sends a PUT request to update a document', async () => {
    const doc = { content: 'updated content' };
    const expected = { document: { id: 'doc-1', content: 'updated content' } };
    vi.mocked(apiPut).mockResolvedValueOnce(expected);

    const result = await updateRagDocument('doc-1', doc);

    expect(apiPut).toHaveBeenCalledWith('/analytics/rag-documents/doc-1', doc);
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPut', async () => {
    vi.mocked(apiPut).mockRejectedValueOnce(new Error('Not found'));

    await expect(updateRagDocument('doc-1', { content: 'x' })).rejects.toThrow('Not found');
  });
});

describe('deleteRagDocument', () => {
  it('sends a DELETE request for the document', async () => {
    vi.mocked(apiDelete).mockResolvedValueOnce(undefined);

    await deleteRagDocument('doc-1');

    expect(apiDelete).toHaveBeenCalledWith('/analytics/rag-documents/doc-1');
  });

  it('propagates errors from apiDelete', async () => {
    vi.mocked(apiDelete).mockRejectedValueOnce(new Error('Server error'));

    await expect(deleteRagDocument('doc-1')).rejects.toThrow('Server error');
  });
});

describe('toggleRagDocumentPin', () => {
  it('sends a PATCH request to pin a document', async () => {
    const expected = { id: 'doc-1', pinned: true };
    vi.mocked(apiPatch).mockResolvedValueOnce(expected);

    const result = await toggleRagDocumentPin('doc-1', true);

    expect(apiPatch).toHaveBeenCalledWith('/analytics/rag-documents/doc-1/pin', { pinned: true });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPatch', async () => {
    vi.mocked(apiPatch).mockRejectedValueOnce(new Error('Pin failed'));

    await expect(toggleRagDocumentPin('doc-1', true)).rejects.toThrow('Pin failed');
  });
});

describe('reseedRagDocuments', () => {
  it('sends a POST request to reseed', async () => {
    const expected = { message: 'Reseeded 5 documents' };
    vi.mocked(apiPost).mockResolvedValueOnce(expected);

    const result = await reseedRagDocuments();

    expect(apiPost).toHaveBeenCalledWith('/analytics/rag-documents/reseed');
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPost', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('Reseed failed'));

    await expect(reseedRagDocuments()).rejects.toThrow('Reseed failed');
  });
});

describe('rerunQuery', () => {
  it('sends a POST request with sql and userEmail', async () => {
    const expected = { data: [{ count: 5 }] };
    vi.mocked(apiPost).mockResolvedValueOnce(expected);

    const result = await rerunQuery('SELECT COUNT(*) FROM devices', 'user@test.com');

    expect(apiPost).toHaveBeenCalledWith('/analytics/rerun', {
      sql: 'SELECT COUNT(*) FROM devices',
      userEmail: 'user@test.com',
    });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPost', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('Bad SQL'));

    await expect(rerunQuery('BAD SQL', 'user@test.com')).rejects.toThrow('Bad SQL');
  });
});

describe('submitFeedback', () => {
  it('sends a POST request with feedback', async () => {
    const req = { queryId: 'q-1', rating: 1, userEmail: 'user@test.com' } as any;
    const expected = { success: true, indexed: true };
    vi.mocked(apiPost).mockResolvedValueOnce(expected);

    const result = await submitFeedback(req);

    expect(apiPost).toHaveBeenCalledWith('/analytics/feedback', req);
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiPost', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('Feedback failed'));

    await expect(submitFeedback({} as any)).rejects.toThrow('Feedback failed');
  });
});

describe('listNegativeFeedback', () => {
  it('fetches feedback with default limit', async () => {
    const expected = { items: [] };
    vi.mocked(apiGet).mockResolvedValueOnce(expected);

    const result = await listNegativeFeedback();

    expect(apiGet).toHaveBeenCalledWith('/analytics/feedback', { limit: 100 });
    expect(result).toEqual(expected);
  });

  it('propagates errors from apiGet', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('Failed to fetch feedback: 500'));

    await expect(listNegativeFeedback()).rejects.toThrow('Failed to fetch feedback: 500');
  });
});

describe('deleteNegativeFeedback', () => {
  it('calls apiFetch with DELETE and a JSON body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(undefined);

    await deleteNegativeFeedback('user@test.com', 1700000000);

    expect(apiFetch).toHaveBeenCalledWith('/analytics/feedback', {
      method: 'DELETE',
      body: JSON.stringify({ userEmail: 'user@test.com', ratedAt: 1700000000 }),
    });
  });

  it('propagates errors from apiFetch', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Delete failed'));

    await expect(deleteNegativeFeedback('user@test.com', 1700000000)).rejects.toThrow('Delete failed');
  });
});
