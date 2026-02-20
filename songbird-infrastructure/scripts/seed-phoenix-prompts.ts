/**
 * Seed Phoenix Prompt Hub with Songbird's prompt templates.
 *
 * Usage:
 *   PHOENIX_HOST=https://phoenix.songbird.live npx tsx scripts/seed-phoenix-prompts.ts
 *
 * This creates two prompts:
 *   - songbird-sql-generator: Text-to-SQL prompt with schema, examples, and instructions
 *   - songbird-insights-generator: Data insights generation prompt
 *
 * Each prompt is created with a "production" tag so the Lambda can fetch it immediately.
 */

import { createClient } from '@arizeai/phoenix-client';
import { createPrompt, promptVersion } from '@arizeai/phoenix-client/prompts';

// The SQL generation prompt combines schema context, few-shot examples, and task instructions
const SQL_GENERATOR_TEMPLATE = `You are a SQL expert helping users analyze their Songbird IoT device data.
You will convert natural language questions into PostgreSQL queries.

**Database Schema (PostgreSQL on Aurora Serverless v2):**

1. **analytics.devices** - Device metadata
   - serial_number VARCHAR(100) PRIMARY KEY
   - device_uid VARCHAR(100)
   - name VARCHAR(255)
   - fleet_name VARCHAR(255)
   - fleet_uid VARCHAR(100)
   - status VARCHAR(50) - 'active', 'inactive', 'warning', 'error'
   - last_seen BIGINT - Unix timestamp
   - voltage DOUBLE PRECISION
   - temperature DOUBLE PRECISION
   - last_location_lat DOUBLE PRECISION
   - last_location_lon DOUBLE PRECISION

2. **analytics.telemetry** - Time-series sensor data (partitioned by time)
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - time TIMESTAMP WITH TIME ZONE
   - temperature DOUBLE PRECISION - in Celsius
   - humidity DOUBLE PRECISION - percentage
   - pressure DOUBLE PRECISION - in kPa
   - voltage DOUBLE PRECISION - in volts
   - event_type VARCHAR(100)

3. **analytics.locations** - GPS and location data (partitioned by time)
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - time TIMESTAMP WITH TIME ZONE
   - lat DOUBLE PRECISION
   - lon DOUBLE PRECISION
   - source VARCHAR(50) - 'gps', 'tower', 'wifi'
   - journey_id BIGINT

4. **analytics.alerts** - Device alerts
   - alert_id VARCHAR(100) PRIMARY KEY
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - alert_type VARCHAR(100)
   - severity VARCHAR(50) - 'info', 'warning', 'critical'
   - message TEXT
   - acknowledged BOOLEAN
   - created_at BIGINT - Unix timestamp

5. **analytics.journeys** - GPS tracking journeys
   - device_uid VARCHAR(100)
   - serial_number VARCHAR(100)
   - journey_id BIGINT
   - start_time BIGINT - Unix timestamp
   - end_time BIGINT - Unix timestamp
   - status VARCHAR(50) - 'active', 'completed'
   - distance_km DOUBLE PRECISION

**Important Query Rules:**
1. ALWAYS include "WHERE serial_number IN (:deviceFilter)" in queries
2. Use "time > NOW() - INTERVAL '90 days'" for recent data unless user specifies otherwise
3. For timestamps, convert Unix timestamps with "TO_TIMESTAMP(created_at)"
4. Limit results to 1000 rows max
5. Use proper aggregations (GROUP BY, ORDER BY, LIMIT)
6. Return results suitable for visualization
7. If user asks for "recent" or "last week" data but results are empty, try a longer time range

**Available Device Filter:**
The :deviceFilter placeholder will be automatically replaced with the user's accessible device serial numbers.

**Example 1: Recent Locations**
Q: "Give me the last ten unique locations where my devices have reported a location"
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
Visualization: map
Explanation: Shows the 10 most recent unique locations across all devices.

**Example 2: Temperature Anomalies**
Q: "Show me all the times that temperature spiked suddenly"
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
SELECT
  serial_number,
  time,
  temperature,
  prev_temp,
  temp_diff
FROM temp_changes
WHERE ABS(temp_diff) > 5
ORDER BY ABS(temp_diff) DESC
LIMIT 100;
\`\`\`
Visualization: scatter
Explanation: Identifies sudden temperature changes greater than 5°C.

**Example 3: Power Usage Over Time**
Q: "Graph my power usage for the last week"
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
Visualization: line_chart
Explanation: Shows average voltage (as proxy for power usage) per hour.

**Example 4: Temperature Comparison**
Q: "Compare the average temperature between my different devices"
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
Visualization: bar_chart
Explanation: Compares temperature statistics across devices.

**Example 5: Alert Analysis**
Q: "What devices have alerted the most in the past month?"
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
Visualization: table
Explanation: Shows alert frequency by device and type.

Based on the user's question, generate:

1. A PostgreSQL query following the schema and rules above
2. A suggested visualization type: line_chart, bar_chart, table, map, scatter, or gauge
3. A brief explanation of what the query does

Return your response in this JSON format:
{
  "sql": "SELECT...",
  "visualizationType": "line_chart",
  "explanation": "This query shows..."
}

**CRITICAL REQUIREMENTS:**
- MUST include "WHERE serial_number IN (:deviceFilter)" in all queries
- ONLY use SELECT statements (no INSERT, UPDATE, DELETE, DROP, etc.)
- Limit results to 1000 rows max
- Use proper SQL syntax for PostgreSQL
- Return valid JSON only

User Question: "{{question}}"`;

const INSIGHTS_GENERATOR_TEMPLATE = `You analyzed IoT device data for this question: "{{question}}"

SQL Query executed:
\`\`\`sql
{{sql}}
\`\`\`

Query Results ({{data_count}} rows):
{{data_preview}}

Generate a 2-3 sentence insight summary highlighting:
1. Key findings from the data
2. Any notable patterns or anomalies
3. Actionable recommendations if applicable

Keep it concise and user-friendly.`;

// Anthropic API model ID (used by Phoenix Playground)
// The corresponding Bedrock ID is 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
const ANTHROPIC_MODEL_ID = 'claude-sonnet-4-5-20250929';

async function main() {
  if (!process.env.PHOENIX_HOST) {
    console.error('Error: PHOENIX_HOST environment variable is required');
    console.error('Usage: PHOENIX_HOST=https://phoenix.songbird.live npx tsx scripts/seed-phoenix-prompts.ts');
    process.exit(1);
  }

  console.log(`Connecting to Phoenix at ${process.env.PHOENIX_HOST}...`);

  // Create the client (picks up PHOENIX_HOST from env automatically)
  const client = createClient();

  // Create SQL generator prompt
  console.log('Creating songbird-sql-generator prompt...');
  const sqlPrompt = await createPrompt({
    client,
    name: 'songbird-sql-generator',
    description: 'Converts natural language questions into PostgreSQL queries for Songbird IoT device analytics',
    version: promptVersion({
      description: 'Initial version with schema context, 5 few-shot examples, and task instructions',
      modelProvider: 'ANTHROPIC',
      modelName: ANTHROPIC_MODEL_ID,
      invocationParameters: {
        max_tokens: 4096,
        temperature: 0.0,
      },
      template: [
        {
          role: 'user',
          content: SQL_GENERATOR_TEMPLATE,
        },
      ],
    }),
  });
  console.log(`  Created prompt version: ${sqlPrompt.id}`);

  // Create insights generator prompt
  console.log('Creating songbird-insights-generator prompt...');
  const insightsPrompt = await createPrompt({
    client,
    name: 'songbird-insights-generator',
    description: 'Generates concise data insights from SQL query results for Songbird analytics',
    version: promptVersion({
      description: 'Initial version - generates 2-3 sentence insight summaries',
      modelProvider: 'ANTHROPIC',
      modelName: ANTHROPIC_MODEL_ID,
      invocationParameters: {
        max_tokens: 500,
        temperature: 0.5,
      },
      template: [
        {
          role: 'user',
          content: INSIGHTS_GENERATOR_TEMPLATE,
        },
      ],
    }),
  });
  console.log(`  Created prompt version: ${insightsPrompt.id}`);

  // Tag both as "production"
  console.log('Tagging prompt versions as "production"...');

  await client.POST('/v1/prompt_versions/{prompt_version_id}/tags', {
    params: { path: { prompt_version_id: sqlPrompt.id } },
    body: { name: 'production', description: 'Active production version' },
  });
  console.log('  Tagged songbird-sql-generator as production');

  await client.POST('/v1/prompt_versions/{prompt_version_id}/tags', {
    params: { path: { prompt_version_id: insightsPrompt.id } },
    body: { name: 'production', description: 'Active production version' },
  });
  console.log('  Tagged songbird-insights-generator as production');

  console.log('\nDone! Prompts are ready in Phoenix Prompt Hub.');
  console.log(`View them at: ${process.env.PHOENIX_HOST}`);
}

main().catch((err) => {
  console.error('Failed to seed prompts:', err);
  process.exit(1);
});
