import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn(),
}));

vi.mock('./client', () => ({
  getApiBaseUrl: vi.fn(() => 'https://api.test'),
}));

import { fetchAuthSession } from 'aws-amplify/auth';
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

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchAuthSession).mockResolvedValue({
    tokens: { idToken: { toString: () => 'test-token' } },
  } as any);
});

describe('chatQuery', () => {
  it('sends a POST request and returns the result', async () => {
    const expected = { sql: 'SELECT 1', data: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await chatQuery({ query: 'how many devices?' } as any);

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ query: 'how many devices?' }),
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal error' }),
    });

    await expect(chatQuery({ query: 'fail' } as any)).rejects.toThrow('Internal error');
  });
});

describe('getChatHistory', () => {
  it('fetches chat history with default limit', async () => {
    const expected = { items: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await getChatHistory('user@test.com');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/analytics/history?userEmail=user%40test.com&limit=50',
      { headers: { Authorization: 'Bearer test-token' } }
    );
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(getChatHistory('user@test.com')).rejects.toThrow('Failed to fetch chat history: 403');
  });
});

describe('listSessions', () => {
  it('fetches sessions with custom limit', async () => {
    const expected = { sessions: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await listSessions('user@test.com', 10);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/analytics/sessions?userEmail=user%40test.com&limit=10',
      { headers: { Authorization: 'Bearer test-token' } }
    );
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(listSessions('user@test.com')).rejects.toThrow('Failed to fetch sessions: 500');
  });
});

describe('getSession', () => {
  it('fetches a specific session', async () => {
    const expected = { session: { id: 'sess-1' } };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await getSession('sess-1', 'user@test.com');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/analytics/sessions/sess-1?userEmail=user%40test.com',
      { headers: { Authorization: 'Bearer test-token' } }
    );
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(getSession('sess-1', 'user@test.com')).rejects.toThrow('Failed to fetch session: 404');
  });
});

describe('deleteSession', () => {
  it('sends a DELETE request for the session', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await deleteSession('sess-1', 'user@test.com');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/analytics/sessions/sess-1?userEmail=user%40test.com',
      { method: 'DELETE', headers: { Authorization: 'Bearer test-token' } }
    );
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Delete failed' }),
    });

    await expect(deleteSession('sess-1', 'user@test.com')).rejects.toThrow('Delete failed');
  });
});

describe('listRagDocuments', () => {
  it('fetches all RAG documents without docType', async () => {
    const expected = { documents: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await listRagDocuments();

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rag-documents', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(result).toEqual(expected);
  });

  it('fetches RAG documents filtered by docType', async () => {
    const expected = { documents: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    await listRagDocuments('schema');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test/analytics/rag-documents?doc_type=schema',
      { headers: { Authorization: 'Bearer test-token' } }
    );
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(listRagDocuments()).rejects.toThrow('Failed to fetch RAG documents: 500');
  });
});

describe('createRagDocument', () => {
  it('sends a POST request to create a document', async () => {
    const doc = { doc_type: 'schema' as const, content: 'table info' };
    const expected = { document: { id: 'doc-1', ...doc } };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await createRagDocument(doc);

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rag-documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify(doc),
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Invalid doc' }),
    });

    await expect(createRagDocument({ doc_type: 'schema', content: '' })).rejects.toThrow('Invalid doc');
  });
});

describe('updateRagDocument', () => {
  it('sends a PUT request to update a document', async () => {
    const doc = { content: 'updated content' };
    const expected = { document: { id: 'doc-1', content: 'updated content' } };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await updateRagDocument('doc-1', doc);

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rag-documents/doc-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify(doc),
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    await expect(updateRagDocument('doc-1', { content: 'x' })).rejects.toThrow('Not found');
  });
});

describe('deleteRagDocument', () => {
  it('sends a DELETE request for the document', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await deleteRagDocument('doc-1');

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rag-documents/doc-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    await expect(deleteRagDocument('doc-1')).rejects.toThrow('Server error');
  });
});

describe('toggleRagDocumentPin', () => {
  it('sends a PATCH request to pin a document', async () => {
    const expected = { id: 'doc-1', pinned: true };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await toggleRagDocumentPin('doc-1', true);

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rag-documents/doc-1/pin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ pinned: true }),
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Pin failed' }),
    });

    await expect(toggleRagDocumentPin('doc-1', true)).rejects.toThrow('Pin failed');
  });
});

describe('reseedRagDocuments', () => {
  it('sends a POST request to reseed', async () => {
    const expected = { message: 'Reseeded 5 documents' };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await reseedRagDocuments();

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rag-documents/reseed', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Reseed failed' }),
    });

    await expect(reseedRagDocuments()).rejects.toThrow('Reseed failed');
  });
});

describe('rerunQuery', () => {
  it('sends a POST request with sql and userEmail', async () => {
    const expected = { data: [{ count: 5 }] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await rerunQuery('SELECT COUNT(*) FROM devices', 'user@test.com');

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/rerun', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ sql: 'SELECT COUNT(*) FROM devices', userEmail: 'user@test.com' }),
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Bad SQL' }),
    });

    await expect(rerunQuery('BAD SQL', 'user@test.com')).rejects.toThrow('Bad SQL');
  });
});

describe('submitFeedback', () => {
  it('sends a POST request with feedback', async () => {
    const req = { queryId: 'q-1', rating: 1, userEmail: 'user@test.com' } as any;
    const expected = { success: true, indexed: true };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await submitFeedback(req);

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify(req),
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Feedback failed' }),
    });

    await expect(submitFeedback({} as any)).rejects.toThrow('Feedback failed');
  });
});

describe('listNegativeFeedback', () => {
  it('fetches feedback with default limit', async () => {
    const expected = { items: [] };
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(expected) });

    const result = await listNegativeFeedback();

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/feedback?limit=100', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(result).toEqual(expected);
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(listNegativeFeedback()).rejects.toThrow('Failed to fetch feedback: 500');
  });
});

describe('deleteNegativeFeedback', () => {
  it('sends a DELETE request with userEmail and ratedAt', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await deleteNegativeFeedback('user@test.com', 1700000000);

    expect(mockFetch).toHaveBeenCalledWith('https://api.test/analytics/feedback', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ userEmail: 'user@test.com', ratedAt: 1700000000 }),
    });
  });

  it('throws on error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Delete failed' }),
    });

    await expect(deleteNegativeFeedback('user@test.com', 1700000000)).rejects.toThrow('Delete failed');
  });
});
