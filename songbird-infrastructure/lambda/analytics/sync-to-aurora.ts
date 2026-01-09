/**
 * DynamoDB → Aurora Real-Time Sync
 *
 * Processes DynamoDB Stream events and syncs data to Aurora analytics database.
 */

import { DynamoDBStreamEvent, DynamoDBRecord } from 'aws-lambda';
import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

interface TableConfig {
  table: string;
  primaryKey: string[];
  columnMapping: { [key: string]: string };
}

const TABLE_CONFIGS: { [key: string]: TableConfig } = {
  'songbird-devices': {
    table: 'analytics.devices',
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
  'songbird-telemetry': {
    table: 'analytics.telemetry',
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
    },
  },
  'songbird-locations': {
    table: 'analytics.locations',
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
  'songbird-alerts': {
    table: 'analytics.alerts',
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
  'songbird-journeys': {
    table: 'analytics.journeys',
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
};

function getTableName(sourceArn: string): string {
  const match = sourceArn.match(/table\/([\w-]+)\//);
  return match ? match[1] : '';
}

function buildUpsertSQL(config: TableConfig, item: any): string {
  const columns: string[] = [];
  const values: string[] = [];

  for (const [sourceCol, targetCol] of Object.entries(config.columnMapping)) {
    if (item[sourceCol] !== undefined) {
      columns.push(targetCol);

      let value = item[sourceCol];

      // Handle timestamps - convert to PostgreSQL timestamp if numeric
      // DynamoDB stores timestamps in milliseconds, TO_TIMESTAMP expects seconds
      if (targetCol === 'time' && typeof value === 'number') {
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
      // Handle nulls
      else if (value === null) {
        values.push('NULL');
      }
    }
  }

  if (columns.length === 0) {
    return '';
  }

  const updateClauses = columns
    .filter(col => !config.primaryKey.includes(col))
    .map(col => `${col} = EXCLUDED.${col}`)
    .join(', ');

  const sql = `
    INSERT INTO ${config.table} (${columns.join(', ')})
    VALUES (${values.join(', ')})
    ${updateClauses ? `ON CONFLICT (${config.primaryKey.join(', ')}) DO UPDATE SET ${updateClauses}` : ''}
  `;

  return sql;
}

function buildDeleteSQL(config: TableConfig, keys: any): string {
  const whereClauses = config.primaryKey.map(key => {
    const value = keys[key];
    if (typeof value === 'string') {
      return `${key} = '${value.replace(/'/g, "''")}'`;
    } else if (typeof value === 'number') {
      return `${key} = ${value}`;
    }
    return '';
  }).filter(c => c);

  return `DELETE FROM ${config.table} WHERE ${whereClauses.join(' AND ')}`;
}

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  try {
    if (!event.Records || event.Records.length === 0) {
      console.log('No records to process');
      return;
    }

    const tableName = getTableName(event.Records[0].eventSourceARN!);
    const config = TABLE_CONFIGS[tableName];

    if (!config) {
      console.log(`No config found for table: ${tableName}`);
      return;
    }

    console.log(`Processing ${event.Records.length} records from ${tableName}`);

    const statements: string[] = [];

    for (const record of event.Records) {
      try {
        if (record.eventName === 'INSERT' || record.eventName === 'MODIFY') {
          const newImage = unmarshall(record.dynamodb!.NewImage as any);
          const sql = buildUpsertSQL(config, newImage);
          if (sql) {
            statements.push(sql);
          }
        } else if (record.eventName === 'REMOVE') {
          const oldImage = unmarshall(record.dynamodb!.OldImage as any);
          const sql = buildDeleteSQL(config, oldImage);
          if (sql) {
            statements.push(sql);
          }
        }
      } catch (error: any) {
        console.error('Error processing record:', error);
        console.error('Record:', JSON.stringify(record, null, 2));
      }
    }

    // Execute statements
    for (const sql of statements) {
      try {
        await rds.send(new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE_NAME,
          sql,
        }));
      } catch (error: any) {
        console.error('SQL execution error:', error);
        console.error('SQL:', sql);
      }
    }

    console.log(`Successfully synced ${statements.length} records to Aurora`);

  } catch (error: any) {
    console.error('Sync error:', error);
    throw error;
  }
};
