import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { handler } from './init-schema';

const rdsMock = mockClient(RDSDataClient);

beforeEach(() => {
  rdsMock.reset();
});

describe('init-schema handler', () => {
  it('returns 200 on successful schema initialization', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    const result = await handler();

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Analytics schema initialized successfully');
  });

  it('executes multiple SQL statements from SCHEMA_SQL', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    // The schema has many statements (CREATE SCHEMA, CREATE TABLE, CREATE INDEX, etc.)
    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls.length).toBeGreaterThan(10);
  });

  it('passes correct cluster, secret, and database ARNs', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const firstCall = calls[0].args[0].input;
    expect(firstCall.resourceArn).toBe(process.env.CLUSTER_ARN);
    expect(firstCall.secretArn).toBe(process.env.SECRET_ARN);
    expect(firstCall.database).toBe(process.env.DATABASE_NAME);
  });

  it('ignores "already exists" errors and continues', async () => {
    let callCount = 0;
    rdsMock.on(ExecuteStatementCommand).callsFake(() => {
      callCount++;
      if (callCount === 2) {
        throw new Error('relation "analytics.devices" already exists');
      }
      return {};
    });

    const result = await handler();

    expect(result.statusCode).toBe(200);
    // Should have continued past the error
    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    expect(calls.length).toBeGreaterThan(2);
  });

  it('throws on non-"already exists" errors', async () => {
    rdsMock.on(ExecuteStatementCommand).rejects(new Error('permission denied'));

    await expect(handler()).rejects.toThrow('permission denied');
  });

  it('strips comment-only lines from SQL statements', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    for (const call of calls) {
      const sql = call.args[0].input.sql!;
      const lines = sql.split('\n');
      for (const line of lines) {
        expect(line.trim().startsWith('--')).toBe(false);
      }
    }
  });

  it('does not execute empty statements', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    for (const call of calls) {
      const sql = call.args[0].input.sql!;
      expect(sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('includes CREATE SCHEMA statement', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sqlStatements = calls.map(c => c.args[0].input.sql!.toLowerCase());
    expect(sqlStatements.some(s => s.includes('create schema'))).toBe(true);
  });

  it('includes analytics tables (devices, telemetry, locations, alerts, journeys)', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sqlStatements = calls.map(c => c.args[0].input.sql!.toLowerCase());

    expect(sqlStatements.some(s => s.includes('analytics.devices'))).toBe(true);
    expect(sqlStatements.some(s => s.includes('analytics.telemetry'))).toBe(true);
    expect(sqlStatements.some(s => s.includes('analytics.locations'))).toBe(true);
    expect(sqlStatements.some(s => s.includes('analytics.alerts'))).toBe(true);
    expect(sqlStatements.some(s => s.includes('analytics.journeys'))).toBe(true);
  });

  it('includes rag_documents table with vector extension', async () => {
    rdsMock.on(ExecuteStatementCommand).resolves({});

    await handler();

    const calls = rdsMock.commandCalls(ExecuteStatementCommand);
    const sqlStatements = calls.map(c => c.args[0].input.sql!.toLowerCase());

    expect(sqlStatements.some(s => s.includes('create extension') && s.includes('vector'))).toBe(true);
    expect(sqlStatements.some(s => s.includes('analytics.rag_documents'))).toBe(true);
  });
});
