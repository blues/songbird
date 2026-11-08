import { describe, it, expect, vi } from 'vitest';

// The chat-query module initializes Phoenix tracing and constructs AWS SDK
// clients at import time. Stub the heavy/external pieces so the module can be
// imported in a unit-test context without real credentials or network access.
vi.mock('../shared/tracing', () => ({
  initializeTracing: vi.fn(),
  traceAsyncFn: vi.fn(),
  flushSpans: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../shared/phoenix-prompts', () => ({
  getPromptTemplate: vi.fn(),
  renderTemplate: vi.fn(),
  toBedrockModelId: vi.fn(),
}));

vi.mock('../shared/rag-retrieval', () => ({
  retrieveRelevantContext: vi.fn(),
  formatRetrievedContext: vi.fn(),
}));

// Import the guards after mocks are registered.
const { validateSQL, assertSafeStatement, ALLOWED_TABLES } = await import('./chat-query');

// A representative legitimate query the model is expected to produce.
const LEGIT_QUERY =
  "SELECT serial_number, name FROM analytics.devices WHERE serial_number IN (:deviceFilter) AND last_seen > 0 LIMIT 100";

describe('validateSQL — legitimate queries pass', () => {
  it('accepts a well-formed SELECT scoped to :deviceFilter', () => {
    expect(() => validateSQL(LEGIT_QUERY)).not.toThrow();
  });

  it('accepts an unprefixed table name (schema prefix applied at execution)', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM telemetry WHERE serial_number IN (:deviceFilter) LIMIT 10"
      )
    ).not.toThrow();
  });

  it('accepts a query scoped to a literal serial_number ("my device")', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM analytics.telemetry WHERE serial_number = 'dev-123' LIMIT 10"
      )
    ).not.toThrow();
  });

  it('accepts a WITH (CTE) query referencing allow-listed tables', () => {
    const sql =
      "WITH recent AS (SELECT * FROM analytics.telemetry WHERE serial_number IN (:deviceFilter)) " +
      "SELECT serial_number, count(*) FROM recent GROUP BY serial_number";
    expect(() => validateSQL(sql)).not.toThrow();
  });

  it('accepts a JOIN across two allow-listed tables', () => {
    const sql =
      "SELECT d.name, a.severity FROM analytics.devices d " +
      "JOIN analytics.alerts a ON a.serial_number = d.serial_number " +
      "WHERE d.serial_number IN (:deviceFilter)";
    expect(() => validateSQL(sql)).not.toThrow();
  });

  it('tolerates a single trailing semicolon', () => {
    expect(() => validateSQL(LEGIT_QUERY + ';')).not.toThrow();
  });
});

describe('validateSQL — injection attempts are rejected', () => {
  it('rejects stacked statements (semicolon-separated DROP)', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter); DROP TABLE analytics.devices"
      )
    ).toThrow(/single SQL statement/);
  });

  it('rejects a stacked statement even when the second uses no dangerous keyword', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter); SELECT 1"
      )
    ).toThrow(/single SQL statement/);
  });

  it('rejects line comments used to smuggle payloads', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter) -- DROP TABLE devices"
      )
    ).toThrow(/comments are not allowed/);
  });

  it('rejects block comments', () => {
    expect(() =>
      validateSQL(
        "SELECT * /* sneaky */ FROM analytics.devices WHERE serial_number IN (:deviceFilter)"
      )
    ).toThrow(/comments are not allowed/);
  });

  it('rejects non-SELECT leading statements', () => {
    expect(() =>
      validateSQL("SHOW tables")
    ).toThrow(/Only SELECT queries are allowed/);
  });

  it('rejects dangerous keywords appearing anywhere', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM analytics.devices WHERE serial_number IN (:deviceFilter) UNION SELECT * FROM pg_user"
      )
    ).toThrow(/system catalogs|allow-list|not allowed/);
  });

  it('rejects access to information_schema', () => {
    expect(() =>
      validateSQL(
        "SELECT table_name FROM information_schema.tables WHERE serial_number IN (:deviceFilter)"
      )
    ).toThrow(/system catalogs/);
  });

  it('rejects pg_catalog / system tables', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM pg_catalog.pg_tables WHERE serial_number IN (:deviceFilter)"
      )
    ).toThrow(/system catalogs/);
  });

  it('rejects tables outside the allow-list', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM analytics.secrets WHERE serial_number IN (:deviceFilter)"
      )
    ).toThrow(/allow-list/);
  });

  it('rejects a non-analytics schema', () => {
    expect(() =>
      validateSQL(
        "SELECT * FROM public.devices WHERE serial_number IN (:deviceFilter)"
      )
    ).toThrow(/schema 'public' is not allowed/);
  });

  it('rejects queries missing any device-scope filter', () => {
    expect(() =>
      validateSQL("SELECT * FROM analytics.devices LIMIT 10")
    ).toThrow(/device filter/);
  });
});

describe('assertSafeStatement — structural guard reused post-rewrite', () => {
  it('is exported and rejects stacked statements directly', () => {
    expect(() =>
      assertSafeStatement("SELECT 1; DROP TABLE analytics.devices")
    ).toThrow(/single SQL statement/);
  });

  it('rejects comments directly', () => {
    expect(() => assertSafeStatement("SELECT 1 -- x")).toThrow(/comments/);
  });
});

describe('ALLOWED_TABLES registry', () => {
  it('contains exactly the known analytics tables', () => {
    expect([...ALLOWED_TABLES].sort()).toEqual(
      ['alerts', 'devices', 'journeys', 'locations', 'telemetry'].sort()
    );
  });
});
