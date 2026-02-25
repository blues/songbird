/**
 * RAG Document Seeder
 *
 * One-time (or on-demand) Lambda that seeds the analytics.rag_documents
 * table with schema chunks, few-shot Q→SQL examples, and Songbird domain
 * knowledge. Re-run this Lambda whenever the corpus needs to be refreshed.
 *
 * Upserts by title to avoid duplicates.
 */

import { RDSDataClient, ExecuteStatementCommand, SqlParameter } from '@aws-sdk/client-rds-data';
import { embedText } from '../shared/rag-retrieval';

const rds = new RDSDataClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;
const DATABASE_NAME = process.env.DATABASE_NAME!;

// ---------------------------------------------------------------------------
// Document corpus (update here and re-run Lambda to refresh)
// ---------------------------------------------------------------------------

interface RagDocument {
  doc_type: 'schema' | 'example' | 'domain';
  title: string;
  content: string;
  metadata?: Record<string, string>;
}

const SCHEMA_CHUNKS: RagDocument[] = [
  {
    doc_type: 'schema',
    title: 'analytics.devices table',
    content: `Table: analytics.devices — Device metadata
Columns:
  serial_number VARCHAR(100) PRIMARY KEY — stable human-readable ID (e.g., songbird01-bds)
  device_uid VARCHAR(100) — Notecard hardware UID (can change on swap)
  name VARCHAR(255) — display name
  fleet_name VARCHAR(255), fleet_uid VARCHAR(100) — fleet grouping
  status VARCHAR(50) — 'active', 'inactive', 'warning', 'error'
  last_seen BIGINT — Unix timestamp in MILLISECONDS of last event; convert with TO_TIMESTAMP(last_seen/1000)
  voltage DOUBLE PRECISION — latest battery voltage reading
  temperature DOUBLE PRECISION — latest temperature reading
  last_location_lat DOUBLE PRECISION, last_location_lon DOUBLE PRECISION`,
    metadata: { table: 'analytics.devices' },
  },
  {
    doc_type: 'schema',
    title: 'analytics.telemetry table',
    content: `Table: analytics.telemetry — Time-series sensor data (partitioned by time)
Columns:
  device_uid VARCHAR(100)
  serial_number VARCHAR(100)
  time TIMESTAMP WITH TIME ZONE — when the reading was recorded
  temperature DOUBLE PRECISION — in Celsius
  humidity DOUBLE PRECISION — percentage
  pressure DOUBLE PRECISION — in kPa
  voltage DOUBLE PRECISION — battery voltage in volts
  event_type VARCHAR(100)
PRIMARY KEY: (serial_number, time)
Note: always filter by serial_number IN (:deviceFilter) and add a time range.`,
    metadata: { table: 'analytics.telemetry' },
  },
  {
    doc_type: 'schema',
    title: 'analytics.locations table',
    content: `Table: analytics.locations — GPS and cell-tower location data (partitioned by time)
Columns:
  device_uid VARCHAR(100)
  serial_number VARCHAR(100)
  time TIMESTAMP WITH TIME ZONE
  lat DOUBLE PRECISION — latitude
  lon DOUBLE PRECISION — longitude
  source VARCHAR(50) — 'gps', 'tower', 'wifi'
  journey_id BIGINT — links to analytics.journeys
PRIMARY KEY: (serial_number, time)`,
    metadata: { table: 'analytics.locations' },
  },
  {
    doc_type: 'schema',
    title: 'analytics.alerts table',
    content: `Table: analytics.alerts — Device alerts triggered by threshold violations
Columns:
  alert_id VARCHAR(100) PRIMARY KEY
  device_uid VARCHAR(100)
  serial_number VARCHAR(100)
  alert_type VARCHAR(100) — e.g., 'temp_high', 'temp_low'
  severity VARCHAR(50) — 'info', 'warning', 'critical'
  message TEXT
  acknowledged BOOLEAN
  created_at BIGINT — Unix timestamp; convert with TO_TIMESTAMP(created_at)
  acknowledged_at BIGINT, acknowledged_by VARCHAR(255)`,
    metadata: { table: 'analytics.alerts' },
  },
  {
    doc_type: 'schema',
    title: 'analytics.journeys table',
    content: `Table: analytics.journeys — GPS tracking journeys in transit mode
Columns:
  device_uid VARCHAR(100)
  serial_number VARCHAR(100)
  journey_id BIGINT — Unix timestamp when transit started
  start_time BIGINT — Unix timestamp
  end_time BIGINT — Unix timestamp (NULL if still active)
  status VARCHAR(50) — 'active', 'completed'
  distance_km DOUBLE PRECISION
PRIMARY KEY: (serial_number, journey_id)
Join with analytics.locations on journey_id to get GPS points.`,
    metadata: { table: 'analytics.journeys' },
  },
  {
    doc_type: 'schema',
    title: 'Query rules and conventions',
    content: `Critical query rules for Songbird analytics:
1. ALWAYS include WHERE serial_number IN (:deviceFilter) — the placeholder is replaced at runtime.
2. Default time range: time > NOW() - INTERVAL '90 days' unless the user specifies otherwise.
3. CRITICAL: last_seen in analytics.devices is in MILLISECONDS — use TO_TIMESTAMP(last_seen/1000). The columns created_at, start_time, end_time are in SECONDS — use TO_TIMESTAMP(column_name).
4. LIMIT results to 1000 rows maximum.
5. Only SELECT queries are allowed (no INSERT, UPDATE, DELETE, DROP, etc.).
6. When joining telemetry or locations, always include serial_number in the GROUP BY.
7. If recent data returns empty, try a longer time range automatically.`,
    metadata: { type: 'rules' },
  },
];

const FEW_SHOT_EXAMPLES: RagDocument[] = [
  {
    doc_type: 'example',
    title: 'Recent Locations',
    content: `Q: "Give me the last ten unique locations where my devices have reported a location"
SQL:
\`\`\`sql
SELECT DISTINCT ON (lat, lon)
  serial_number,
  time,
  lat,
  lon,
  source
FROM analytics.locations
WHERE serial_number IN (:deviceFilter)
  AND time > NOW() - INTERVAL '30 days'
ORDER BY lat, lon, time DESC
LIMIT 10;
\`\`\`
Visualization: map`,
    metadata: { visualization: 'map' },
  },
  {
    doc_type: 'example',
    title: 'Temperature Anomalies',
    content: `Q: "Show me all the times that temperature spiked suddenly"
SQL:
\`\`\`sql
WITH temp_changes AS (
  SELECT
    serial_number,
    time,
    temperature,
    LAG(temperature) OVER (PARTITION BY serial_number ORDER BY time) as prev_temp,
    temperature - LAG(temperature) OVER (PARTITION BY serial_number ORDER BY time) as temp_diff
  FROM analytics.telemetry
  WHERE serial_number IN (:deviceFilter)
    AND time > NOW() - INTERVAL '90 days'
    AND temperature IS NOT NULL
)
SELECT serial_number, time, temperature, prev_temp, temp_diff
FROM temp_changes
WHERE ABS(temp_diff) > 5
ORDER BY ABS(temp_diff) DESC
LIMIT 100;
\`\`\`
Visualization: scatter`,
    metadata: { visualization: 'scatter' },
  },
  {
    doc_type: 'example',
    title: 'Power Usage Over Time',
    content: `Q: "Graph my power usage for the last week"
SQL:
\`\`\`sql
SELECT
  DATE_TRUNC('hour', time) as hour,
  serial_number,
  AVG(voltage) as avg_voltage,
  COUNT(*) as reading_count
FROM analytics.telemetry
WHERE serial_number IN (:deviceFilter)
  AND time > NOW() - INTERVAL '30 days'
  AND voltage IS NOT NULL
GROUP BY DATE_TRUNC('hour', time), serial_number
ORDER BY hour;
\`\`\`
Visualization: line_chart`,
    metadata: { visualization: 'line_chart' },
  },
  {
    doc_type: 'example',
    title: 'Temperature Comparison Across Devices',
    content: `Q: "Compare the average temperature between my different devices"
SQL:
\`\`\`sql
SELECT
  d.serial_number,
  d.name,
  AVG(t.temperature) as avg_temp,
  MIN(t.temperature) as min_temp,
  MAX(t.temperature) as max_temp,
  COUNT(*) as reading_count
FROM analytics.devices d
LEFT JOIN analytics.telemetry t ON d.serial_number = t.serial_number
  AND t.time > NOW() - INTERVAL '30 days'
WHERE d.serial_number IN (:deviceFilter)
GROUP BY d.serial_number, d.name
ORDER BY avg_temp DESC;
\`\`\`
Visualization: bar_chart`,
    metadata: { visualization: 'bar_chart' },
  },
  {
    doc_type: 'example',
    title: 'Alert Analysis by Device',
    content: `Q: "What devices have alerted the most in the past month?"
SQL:
\`\`\`sql
SELECT
  serial_number,
  alert_type,
  COUNT(*) as alert_count,
  COUNT(CASE WHEN acknowledged THEN 1 END) as acknowledged_count
FROM analytics.alerts
WHERE serial_number IN (:deviceFilter)
  AND created_at > EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')
GROUP BY serial_number, alert_type
ORDER BY alert_count DESC
LIMIT 20;
\`\`\`
Visualization: table`,
    metadata: { visualization: 'table' },
  },
];

const DOMAIN_KNOWLEDGE: RagDocument[] = [
  {
    doc_type: 'domain',
    title: 'Operating Modes',
    content: `Songbird devices operate in one of four modes. demo mode uses cell-tower triangulation and syncs immediately — used during live customer demos. transit mode uses GPS tracking every 60 seconds and syncs every 15 minutes — used when assets are actively moving. storage mode uses triangulation and syncs every 60 minutes — used when assets are at rest. sleep mode disables location and only wakes on motion — used for long-term storage. The current mode is set via the mode environment variable in Notehub.`,
    metadata: { category: 'device-behavior' },
  },
  {
    doc_type: 'domain',
    title: 'Journeys',
    content: `A journey is a sequence of GPS tracking points recorded while a device is in transit mode. Each journey has a unique journey_id (Unix timestamp of when transit started), and includes velocity, bearing, distance, and DOP (accuracy) data per point. Journeys have a status of active (currently in transit) or completed. The analytics.journeys table stores journey metadata; join with analytics.locations on journey_id to get individual GPS points.`,
    metadata: { category: 'journeys' },
  },
  {
    doc_type: 'domain',
    title: 'Device Aliasing and Notecard Swapping',
    content: `Each Songbird device has a stable human-readable serial number (e.g., songbird01-bds) that is independent of the physical Notecard hardware. When a Notecard is replaced, the new Notecard sends data with the same serial number and the system auto-detects the swap, preserving all historical data. The analytics.devices table uses serial_number as the primary key — not device_uid, which can change after a hardware swap.`,
    metadata: { category: 'devices' },
  },
  {
    doc_type: 'domain',
    title: 'Notecard and Notehub',
    content: `The Notecard is a cellular + GPS module made by Blues Inc. that handles all wireless communication. Notehub is Blues's cloud routing service that receives events from Notecards and forwards them to the Songbird AWS Lambda ingest endpoint. Data flows: Notecard → Notehub → AWS Lambda /ingest → DynamoDB + Aurora. Environment variables set in Notehub are synced back to the device to control behavior such as mode, alert thresholds, and volume.`,
    metadata: { category: 'infrastructure' },
  },
  {
    doc_type: 'domain',
    title: 'Alert Types',
    content: `Songbird devices generate alerts when sensor readings exceed configured thresholds. Alert types include temperature threshold violations (temp_high, temp_low). Thresholds are set via alert_temp_high and alert_temp_low environment variables in Notehub. Alerts have a severity of info, warning, or critical, and can be acknowledged by users in the dashboard. The analytics.alerts table stores all alerts; created_at is a Unix timestamp.`,
    metadata: { category: 'alerts' },
  },
  {
    doc_type: 'domain',
    title: 'Voltage and Battery',
    content: `The voltage field in telemetry represents the device's battery voltage in volts. Songbird is battery-powered, so declining voltage indicates battery depletion. A fully charged LiPo battery is approximately 4.2V; the device should be recharged below approximately 3.5V. Voltage readings are stored in the analytics.telemetry table (voltage column). The analytics.devices table also has a voltage column with the most recent reading.`,
    metadata: { category: 'power' },
  },
];

// ---------------------------------------------------------------------------
// Seeding logic
// ---------------------------------------------------------------------------

async function upsertDocument(doc: RagDocument, embedding: number[]): Promise<void> {
  const embeddingStr = `[${embedding.join(',')}]`;
  const metadataStr = doc.metadata ? JSON.stringify(doc.metadata) : '{}';
  const titleEscaped = doc.title.replace(/'/g, "''");
  const contentEscaped = doc.content.replace(/'/g, "''");

  // Delete existing row with this title, then insert fresh
  await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql: `DELETE FROM analytics.rag_documents WHERE title = '${titleEscaped}'`,
  }));

  const sql = `
    INSERT INTO analytics.rag_documents (doc_type, title, content, embedding, metadata)
    VALUES (
      '${doc.doc_type}',
      '${titleEscaped}',
      '${contentEscaped}',
      '${embeddingStr}'::vector,
      '${metadataStr}'::jsonb
    )
  `;

  await rds.send(new ExecuteStatementCommand({
    resourceArn: CLUSTER_ARN,
    secretArn: SECRET_ARN,
    database: DATABASE_NAME,
    sql,
  }));
}

export const handler = async (): Promise<any> => {
  const allDocs = [...SCHEMA_CHUNKS, ...FEW_SHOT_EXAMPLES, ...DOMAIN_KNOWLEDGE];

  console.log(`Seeding ${allDocs.length} RAG documents...`);

  let seeded = 0;
  let failed = 0;

  for (const doc of allDocs) {
    try {
      console.log(`Embedding: [${doc.doc_type}] ${doc.title}`);
      const embedding = await embedText(doc.content);
      await upsertDocument(doc, embedding);
      seeded++;
      console.log(`Seeded: ${doc.title}`);
    } catch (error: any) {
      console.error(`Failed to seed "${doc.title}":`, error.message);
      failed++;
    }
  }

  const summary = { seeded, failed, total: allDocs.length };
  console.log('Seeding complete:', summary);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'RAG document seeding complete', ...summary }),
  };
};
