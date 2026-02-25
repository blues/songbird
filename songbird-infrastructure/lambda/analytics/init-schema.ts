/**
 * Aurora Analytics Schema Initialization
 *
 * Creates the analytics schema with partitioned tables for telemetry, locations, and journeys.
 */

import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand } from '@aws-sdk/client-rds-data';

const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

const SCHEMA_SQL = `
-- Create analytics schema
CREATE SCHEMA IF NOT EXISTS analytics;

-- Devices table (no partitioning needed)
CREATE TABLE IF NOT EXISTS analytics.devices (
  serial_number VARCHAR(100) PRIMARY KEY,
  device_uid VARCHAR(100),
  name VARCHAR(255),
  fleet_name VARCHAR(255),
  fleet_uid VARCHAR(100),
  product_uid VARCHAR(100),
  last_seen BIGINT,
  last_location_lat DOUBLE PRECISION,
  last_location_lon DOUBLE PRECISION,
  status VARCHAR(50),
  voltage DOUBLE PRECISION,
  temperature DOUBLE PRECISION,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_devices_fleet ON analytics.devices(fleet_uid);
CREATE INDEX IF NOT EXISTS idx_devices_status ON analytics.devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON analytics.devices(last_seen DESC);

-- Telemetry table (partitioned by time)
CREATE TABLE IF NOT EXISTS analytics.telemetry (
  device_uid VARCHAR(100),
  serial_number VARCHAR(100),
  time TIMESTAMP WITH TIME ZONE,
  temperature DOUBLE PRECISION,
  humidity DOUBLE PRECISION,
  pressure DOUBLE PRECISION,
  voltage DOUBLE PRECISION,
  event_type VARCHAR(100),
  PRIMARY KEY (serial_number, time)
) PARTITION BY RANGE (time);

-- Create partitions for telemetry (last 6 months + next 6 months)
CREATE TABLE IF NOT EXISTS analytics.telemetry_2024_q4
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2024-10-01') TO ('2025-01-01');

CREATE TABLE IF NOT EXISTS analytics.telemetry_2025_q1
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');

CREATE TABLE IF NOT EXISTS analytics.telemetry_2025_q2
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2025-04-01') TO ('2025-07-01');

CREATE TABLE IF NOT EXISTS analytics.telemetry_2025_q3
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2025-07-01') TO ('2025-10-01');

CREATE TABLE IF NOT EXISTS analytics.telemetry_2025_q4
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2025-10-01') TO ('2026-01-01');

CREATE TABLE IF NOT EXISTS analytics.telemetry_2026_q1
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');

CREATE TABLE IF NOT EXISTS analytics.telemetry_2026_q2
  PARTITION OF analytics.telemetry
  FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');

CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON analytics.telemetry(serial_number, time DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON analytics.telemetry(event_type, time DESC);

-- Locations table (partitioned by time)
CREATE TABLE IF NOT EXISTS analytics.locations (
  device_uid VARCHAR(100),
  serial_number VARCHAR(100),
  time TIMESTAMP WITH TIME ZONE,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  source VARCHAR(50),
  journey_id BIGINT,
  PRIMARY KEY (serial_number, time)
) PARTITION BY RANGE (time);

-- Create partitions for locations
CREATE TABLE IF NOT EXISTS analytics.locations_2024_q4
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2024-10-01') TO ('2025-01-01');

CREATE TABLE IF NOT EXISTS analytics.locations_2025_q1
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2025-01-01') TO ('2025-04-01');

CREATE TABLE IF NOT EXISTS analytics.locations_2025_q2
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2025-04-01') TO ('2025-07-01');

CREATE TABLE IF NOT EXISTS analytics.locations_2025_q3
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2025-07-01') TO ('2025-10-01');

CREATE TABLE IF NOT EXISTS analytics.locations_2025_q4
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2025-10-01') TO ('2026-01-01');

CREATE TABLE IF NOT EXISTS analytics.locations_2026_q1
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2026-01-01') TO ('2026-04-01');

CREATE TABLE IF NOT EXISTS analytics.locations_2026_q2
  PARTITION OF analytics.locations
  FOR VALUES FROM ('2026-04-01') TO ('2026-07-01');

CREATE INDEX IF NOT EXISTS idx_locations_device_time ON analytics.locations(serial_number, time DESC);
CREATE INDEX IF NOT EXISTS idx_locations_journey ON analytics.locations(serial_number, journey_id);

-- Alerts table (no partitioning for now - less data)
CREATE TABLE IF NOT EXISTS analytics.alerts (
  alert_id VARCHAR(100) PRIMARY KEY,
  device_uid VARCHAR(100),
  serial_number VARCHAR(100),
  alert_type VARCHAR(100),
  severity VARCHAR(50),
  message TEXT,
  acknowledged BOOLEAN,
  created_at BIGINT,
  acknowledged_at BIGINT,
  acknowledged_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_alerts_device ON analytics.alerts(serial_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON analytics.alerts(acknowledged, created_at DESC);

-- Journeys table (no partitioning for now)
CREATE TABLE IF NOT EXISTS analytics.journeys (
  device_uid VARCHAR(100),
  serial_number VARCHAR(100),
  journey_id BIGINT,
  start_time BIGINT,
  end_time BIGINT,
  status VARCHAR(50),
  distance_km DOUBLE PRECISION,
  PRIMARY KEY (serial_number, journey_id)
);

CREATE INDEX IF NOT EXISTS idx_journeys_status ON analytics.journeys(status, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_journeys_device_time ON analytics.journeys(serial_number, start_time DESC);

-- pgvector extension for RAG embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- RAG documents table (schema chunks, few-shot examples, domain knowledge)
CREATE TABLE IF NOT EXISTS analytics.rag_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type VARCHAR(50) NOT NULL,
  title VARCHAR(255),
  content TEXT NOT NULL,
  embedding vector(1024),
  metadata JSONB,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding
  ON analytics.rag_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_documents_title
  ON analytics.rag_documents (title);

-- Materialized view for device stats (for faster queries)
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.device_stats AS
SELECT
  d.serial_number,
  d.name,
  d.fleet_name,
  d.status,
  d.last_seen,
  COUNT(DISTINCT t.time) as telemetry_count,
  COUNT(DISTINCT a.alert_id) as alert_count,
  MAX(t.temperature) as max_temp,
  MIN(t.temperature) as min_temp,
  AVG(t.temperature) as avg_temp
FROM analytics.devices d
LEFT JOIN analytics.telemetry t ON d.serial_number = t.serial_number
  AND t.time > NOW() - INTERVAL '30 days'
LEFT JOIN analytics.alerts a ON d.serial_number = a.serial_number
  AND a.created_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')
GROUP BY d.serial_number, d.name, d.fleet_name, d.status, d.last_seen;

-- Grant permissions
GRANT USAGE ON SCHEMA analytics TO PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO PUBLIC;
`;

export const handler = async (): Promise<any> => {
  try {
    console.log('Initializing Aurora analytics schema...');

    // Split SQL into individual statements and remove comment-only lines
    const statements = SCHEMA_SQL
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => {
        // Remove comment lines from the start of each statement
        const lines = s.split('\n');
        const nonCommentLines = lines.filter(line => !line.trim().startsWith('--'));
        return nonCommentLines.join('\n').trim();
      })
      .filter(s => s.length > 0);

    // Execute each statement
    for (const sql of statements) {
      try {
        await rds.send(new ExecuteStatementCommand({
          resourceArn: CLUSTER_ARN,
          secretArn: SECRET_ARN,
          database: DATABASE_NAME,
          sql,
        }));
        console.log(`Executed: ${sql.substring(0, 50)}...`);
      } catch (error: any) {
        // Ignore "already exists" errors
        if (error.message?.includes('already exists')) {
          console.log(`Skipped (already exists): ${sql.substring(0, 50)}...`);
        } else {
          throw error;
        }
      }
    }

    console.log('Schema initialization complete');

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Analytics schema initialized successfully',
      }),
    };

  } catch (error: any) {
    console.error('Schema initialization failed:', error);
    throw error;
  }
};
