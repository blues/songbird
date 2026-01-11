/**
 * Re-run Query Lambda
 *
 * Re-executes a stored SQL query from chat history to regenerate visualization data.
 * Used when loading historical conversations to render charts/maps.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

interface RerunRequest {
  sql: string;
  userEmail: string;
}

function validateSQL(sql: string): void {
  const lowerSQL = sql.toLowerCase();

  // Only allow SELECT statements
  if (!lowerSQL.trim().startsWith('select') && !lowerSQL.trim().startsWith('with')) {
    throw new Error('Only SELECT queries are allowed');
  }

  // Block dangerous keywords
  const dangerousKeywords = [
    'insert', 'update', 'delete', 'drop', 'truncate', 'alter',
    'create', 'grant', 'revoke', 'exec', 'execute'
  ];

  for (const keyword of dangerousKeywords) {
    if (lowerSQL.includes(keyword)) {
      throw new Error(`Keyword '${keyword}' is not allowed`);
    }
  }

  // Must include device filter
  if (!sql.includes(':deviceFilter')) {
    throw new Error('Query must include device filter (:deviceFilter)');
  }
}

async function executeQuery(sql: string, deviceSerialNumbers: string[]): Promise<any[]> {
  // Replace device filter placeholder
  const deviceList = deviceSerialNumbers.map(sn => `'${sn.replace(/'/g, "''")}'`).join(', ');
  const finalSQL = sql.replace(':deviceFilter', deviceList);

  console.log('Re-executing SQL:', finalSQL);

  const response = await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql: finalSQL,
    includeResultMetadata: true,
  }));

  if (!response.records) {
    return [];
  }

  // Convert RDS Data API format to JSON
  const columnMetadata = response.columnMetadata || [];
  const records = response.records.map(record => {
    const row: any = {};
    record.forEach((field, index) => {
      const columnName = columnMetadata[index]?.name || `column_${index}`;
      let value: any = null;
      if (field.stringValue !== undefined) {
        value = field.stringValue;
      } else if (field.longValue !== undefined) {
        value = field.longValue;
      } else if (field.doubleValue !== undefined) {
        value = field.doubleValue;
      } else if (field.booleanValue !== undefined) {
        value = field.booleanValue;
      } else if (field.isNull) {
        value = null;
      }
      row[columnName] = value;
    });
    return row;
  });

  return records;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const request: RerunRequest = JSON.parse(event.body || '{}');

    if (!request.sql || !request.userEmail) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ error: 'Missing required fields (sql, userEmail)' }),
      };
    }

    // Validate SQL before execution
    validateSQL(request.sql);

    // Get all device serial numbers (user has access to all in this implementation)
    const devicesResult = await rds.send(new ExecuteStatementCommand({
      resourceArn: CLUSTER_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE_NAME,
      sql: 'SELECT DISTINCT serial_number FROM analytics.devices',
    }));

    let deviceSerialNumbers = (devicesResult.records || [])
      .map(record => record[0]?.stringValue)
      .filter((sn): sn is string => !!sn);

    // Fallback: check telemetry table if devices table is empty
    if (deviceSerialNumbers.length === 0) {
      const telemetryResult = await rds.send(new ExecuteStatementCommand({
        resourceArn: CLUSTER_ARN,
        secretArn: SECRET_ARN,
        database: DATABASE_NAME,
        sql: 'SELECT DISTINCT serial_number FROM analytics.telemetry LIMIT 100',
      }));

      deviceSerialNumbers = (telemetryResult.records || [])
        .map(record => record[0]?.stringValue)
        .filter((sn): sn is string => !!sn);
    }

    // Execute the stored query
    const data = await executeQuery(request.sql, deviceSerialNumbers);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ data }),
    };

  } catch (error: any) {
    console.error('Rerun query error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: error.message || 'Internal server error',
      }),
    };
  }
};
