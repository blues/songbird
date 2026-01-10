export interface QueryResult {
  sql: string;
  explanation: string;
  visualizationType: 'line_chart' | 'bar_chart' | 'table' | 'map' | 'scatter' | 'gauge';
  data: any[];
  insights: string;
}

export interface ChatRequest {
  question: string;
  sessionId: string;
  userEmail: string;
}

export interface ChatHistoryItem {
  user_email: string;
  timestamp: number;
  session_id: string;
  question: string;
  sql: string;
  explanation: string;
  visualization_type: string;
  row_count: number;
  insights: string;
}

export interface ChatHistoryResponse {
  history: ChatHistoryItem[];
  total: number;
}

export interface SessionSummary {
  sessionId: string;
  firstQuestion: string;
  lastQuestion: string;
  startTimestamp: number;
  lastTimestamp: number;
  messageCount: number;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
}

export interface SessionResponse {
  sessionId: string;
  messages: ChatHistoryItem[];
  total: number;
}
