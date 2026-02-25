/**
 * Aurora Analytics Backfill Lambda
 *
 * One-time backfill of existing DynamoDB data to Aurora analytics database.
 * Invoke manually to populate historical data.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

interface BackfillConfig {
  dynamoTable: string;
  auroraTable: string;
  primaryKey: string[];
  columnMapping: { [key: string]: string };
}

const TABLES: BackfillConfig[] = [
  {
    dynamoTable: 'songbird-devices',
    auroraTable: 'analytics.devices',
    primaryKey: ['serial_number'],
    columnMapping: {
      serial_number: 'serial_number',
      device_uid: 'device_uid',
      name: 'name',
      fleet_name: 'fleet_name',
      fleet_uid: 'fleet_uid',
      product_uid: 'product_uid',
      last_seen: 'last_seen',
      last_location_lat: 'last_location_lat',
      last_location_lon: 'last_location_lon',
      status: 'status',
      voltage: 'voltage',
      temperature: 'temperature',
      created_at: 'created_at',
      updated_at: 'updated_at',
    },
  },
  {
    dynamoTable: 'songbird-telemetry',
    auroraTable: 'analytics.telemetry',
    primaryKey: ['serial_number', 'time'],
    columnMapping: {
      device_uid: 'device_uid',
      serial_number: 'serial_number',
      timestamp: 'time',
      temperature: 'temperature',
      humidity: 'humidity',
      pressure: 'pressure',
      voltage: 'voltage',
      event_type: 'event_type',
      milliamp_hours: 'milliamp_hours',
      mojo_voltage: 'mojo_voltage',
    },
  },
  {
    dynamoTable: 'songbird-locations',
    auroraTable: 'analytics.locations',
    primaryKey: ['serial_number', 'time'],
    columnMapping: {
      device_uid: 'device_uid',
      serial_number: 'serial_number',
      timestamp: 'time',
      latitude: 'lat',
      longitude: 'lon',
      source: 'source',
      journey_id: 'journey_id',
    },
  },
  {
    dynamoTable: 'songbird-alerts',
    auroraTable: 'analytics.alerts',
    primaryKey: ['alert_id'],
    columnMapping: {
      alert_id: 'alert_id',
      device_uid: 'device_uid',
      serial_number: 'serial_number',
      alert_type: 'alert_type',
      severity: 'severity',
      message: 'message',
      acknowledged: 'acknowledged',
      created_at: 'created_at',
      acknowledged_at: 'acknowledged_at',
      acknowledged_by: 'acknowledged_by',
    },
  },
  {
    dynamoTable: 'songbird-journeys',
    auroraTable: 'analytics.journeys',
    primaryKey: ['serial_number', 'journey_id'],
    columnMapping: {
      device_uid: 'device_uid',
      serial_number: 'serial_number',
      journey_id: 'journey_id',
      start_time: 'start_time',
      end_time: 'end_time',
      status: 'status',
      total_distance: 'distance_km',
    },
  },
];

function buildUpsertSQL(config: BackfillConfig, item: Record<string, unknown>): string | null {
  const columns: string[] = [];
  const values: string[] = [];

  for (const [sourceCol, targetCol] of Object.entries(config.columnMapping)) {
    const value = item[sourceCol];
    if (value !== undefined && value !== null) {
      columns.push(targetCol);

      // Handle timestamps - convert to PostgreSQL timestamp if numeric
      if (targetCol === 'time' && typeof value === 'number') {
        // Convert milliseconds to seconds if needed
        const seconds = value > 9999999999 ? value / 1000 : value;
        values.push(`TO_TIMESTAMP(${seconds})`);
      }
      // Handle booleans
      else if (typeof value === 'boolean') {
        values.push(value ? 'TRUE' : 'FALSE');
      }
      // Handle strings
      else if (typeof value === 'string') {
        values.push(`'${value.replace(/'/g, "''")}'`);
      }
      // Handle numbers
      else if (typeof value === 'number') {
        values.push(String(value));
      }
    }
  }

  if (columns.length === 0) {
    return null;
  }

  const updateClauses = columns
    .filter(col => !config.primaryKey.includes(col))
    .map(col => `${col} = EXCLUDED.${col}`)
    .join(', ');

  return `
    INSERT INTO ${config.auroraTable} (${columns.join(', ')})
    VALUES (${values.join(', ')})
    ON CONFLICT (${config.primaryKey.join(', ')}) DO UPDATE SET ${updateClauses}
  `;
}

async function backfillTable(config: BackfillConfig): Promise<{ table: string; count: number; errors: number }> {
  console.log(`Backfilling ${config.dynamoTable} → ${config.auroraTable}`);

  let count = 0;
  let errors = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const scanResult = await ddb.send(new ScanCommand({
      TableName: config.dynamoTable,
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 100,
    }));

    const items = scanResult.Items || [];

    for (const item of items) {
      const sql = buildUpsertSQL(config, item);
      if (!sql) continue;

      try {
        await rds.send(new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE_NAME,
          sql,
        }));
        count++;
      } catch (error: unknown) {
        errors++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error inserting into ${config.auroraTable}:`, errorMessage);
        console.error('SQL:', sql.substring(0, 200));
      }
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
    console.log(`  Processed ${count} records so far...`);

  } while (lastEvaluatedKey);

  console.log(`Completed ${config.dynamoTable}: ${count} records, ${errors} errors`);
  return { table: config.dynamoTable, count, errors };
}

export const handler = async (event: { tables?: string[] }): Promise<{
  statusCode: number;
  body: string;
}> => {
  console.log('Starting analytics backfill...');

  const tablesToProcess = event.tables
    ? TABLES.filter(t => event.tables!.includes(t.dynamoTable))
    : TABLES;

  const results = [];

  for (const config of tablesToProcess) {
    try {
      const result = await backfillTable(config);
      results.push(result);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to backfill ${config.dynamoTable}:`, errorMessage);
      results.push({ table: config.dynamoTable, count: 0, errors: -1, error: errorMessage });
    }
  }

  const summary = {
    totalRecords: results.reduce((sum, r) => sum + r.count, 0),
    totalErrors: results.reduce((sum, r) => sum + r.errors, 0),
    tables: results,
  };

  console.log('Backfill complete:', JSON.stringify(summary, null, 2));

  return {
    statusCode: 200,
    body: JSON.stringify(summary, null, 2),
  };
};
