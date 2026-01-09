"use strict";
/**
 * Aurora Analytics Backfill Lambda
 *
 * One-time backfill of existing DynamoDB data to Aurora analytics database.
 * Invoke manually to populate historical data.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const client_rds_data_1 = require("@aws-sdk/client-rds-data");
const ddb = lib_dynamodb_1.DynamoDBDocumentClient.from(new client_dynamodb_1.DynamoDBClient({}));
const rds = new client_rds_data_1.RDSDataClient({});
const CLUSTER_ARN = process.env.CLUSTER_ARN;
const SECRET_ARN = process.env.SECRET_ARN;
const DATABASE_NAME = process.env.DATABASE_NAME;
const TABLES = [
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
function buildUpsertSQL(config, item) {
    const columns = [];
    const values = [];
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
async function backfillTable(config) {
    console.log(`Backfilling ${config.dynamoTable} → ${config.auroraTable}`);
    let count = 0;
    let errors = 0;
    let lastEvaluatedKey;
    do {
        const scanResult = await ddb.send(new lib_dynamodb_1.ScanCommand({
            TableName: config.dynamoTable,
            ExclusiveStartKey: lastEvaluatedKey,
            Limit: 100,
        }));
        const items = scanResult.Items || [];
        for (const item of items) {
            const sql = buildUpsertSQL(config, item);
            if (!sql)
                continue;
            try {
                await rds.send(new client_rds_data_1.ExecuteStatementCommand({
                    resourceArn: CLUSTER_ARN,
                    secretArn: SECRET_ARN,
                    database: DATABASE_NAME,
                    sql,
                }));
                count++;
            }
            catch (error) {
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
const handler = async (event) => {
    console.log('Starting analytics backfill...');
    const tablesToProcess = event.tables
        ? TABLES.filter(t => event.tables.includes(t.dynamoTable))
        : TABLES;
    const results = [];
    for (const config of tablesToProcess) {
        try {
            const result = await backfillTable(config);
            results.push(result);
        }
        catch (error) {
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
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2ZpbGwuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYW5hbHl0aWNzL2JhY2tmaWxsLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7O0FBRUgsOERBQTBEO0FBQzFELHdEQUE0RTtBQUM1RSw4REFBa0Y7QUFFbEYsTUFBTSxHQUFHLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLElBQUksZ0NBQWMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2hFLE1BQU0sR0FBRyxHQUFHLElBQUksK0JBQWEsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUVsQyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFdBQVksQ0FBQztBQUM3QyxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFVBQVcsQ0FBQztBQUMzQyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWMsQ0FBQztBQVNqRCxNQUFNLE1BQU0sR0FBcUI7SUFDL0I7UUFDRSxXQUFXLEVBQUUsa0JBQWtCO1FBQy9CLFdBQVcsRUFBRSxtQkFBbUI7UUFDaEMsVUFBVSxFQUFFLENBQUMsZUFBZSxDQUFDO1FBQzdCLGFBQWEsRUFBRTtZQUNiLGFBQWEsRUFBRSxlQUFlO1lBQzlCLFVBQVUsRUFBRSxZQUFZO1lBQ3hCLElBQUksRUFBRSxNQUFNO1lBQ1osVUFBVSxFQUFFLFlBQVk7WUFDeEIsU0FBUyxFQUFFLFdBQVc7WUFDdEIsV0FBVyxFQUFFLGFBQWE7WUFDMUIsU0FBUyxFQUFFLFdBQVc7WUFDdEIsaUJBQWlCLEVBQUUsbUJBQW1CO1lBQ3RDLGlCQUFpQixFQUFFLG1CQUFtQjtZQUN0QyxNQUFNLEVBQUUsUUFBUTtZQUNoQixPQUFPLEVBQUUsU0FBUztZQUNsQixXQUFXLEVBQUUsYUFBYTtZQUMxQixVQUFVLEVBQUUsWUFBWTtZQUN4QixVQUFVLEVBQUUsWUFBWTtTQUN6QjtLQUNGO0lBQ0Q7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LENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxlQUFlLENBQUM7WUFDOUUsT0FBTyxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsTUFBTSxDQUFDLFdBQVcsR0FBRyxFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQ3pFLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxLQUFLLEVBQUUsTUFBTSxDQUFDLFdBQVcsRUFBRSxLQUFLLEVBQUUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUMsRUFBRSxLQUFLLEVBQUUsWUFBWSxFQUFFLENBQUMsQ0FBQztRQUN6RixDQUFDO0lBQ0gsQ0FBQztJQUVELE1BQU0sT0FBTyxHQUFHO1FBQ2QsWUFBWSxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDMUQsV0FBVyxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7UUFDMUQsTUFBTSxFQUFFLE9BQU87S0FDaEIsQ0FBQztJQUVGLE9BQU8sQ0FBQyxHQUFHLENBQUMsb0JBQW9CLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFFcEUsT0FBTztRQUNMLFVBQVUsRUFBRSxHQUFHO1FBQ2YsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7S0FDdkMsQ0FBQztBQUNKLENBQUMsQ0FBQztBQW5DVyxRQUFBLE9BQU8sV0FtQ2xCIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBdXJvcmEgQW5hbHl0aWNzIEJhY2tmaWxsIExhbWJkYVxuICpcbiAqIE9uZS10aW1lIGJhY2tmaWxsIG9mIGV4aXN0aW5nIER5bmFtb0RCIGRhdGEgdG8gQXVyb3JhIGFuYWx5dGljcyBkYXRhYmFzZS5cbiAqIEludm9rZSBtYW51YWxseSB0byBwb3B1bGF0ZSBoaXN0b3JpY2FsIGRhdGEuXG4gKi9cblxuaW1wb3J0IHsgRHluYW1vREJDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtZHluYW1vZGInO1xuaW1wb3J0IHsgRHluYW1vREJEb2N1bWVudENsaWVudCwgU2NhbkNvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9saWItZHluYW1vZGInO1xuaW1wb3J0IHsgUkRTRGF0YUNsaWVudCwgRXhlY3V0ZVN0YXRlbWVudENvbW1hbmQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtcmRzLWRhdGEnO1xuXG5jb25zdCBkZGIgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20obmV3IER5bmFtb0RCQ2xpZW50KHt9KSk7XG5jb25zdCByZHMgPSBuZXcgUkRTRGF0YUNsaWVudCh7fSk7XG5cbmNvbnN0IENMVVNURVJfQVJOID0gcHJvY2Vzcy5lbnYuQ0xVU1RFUl9BUk4hO1xuY29uc3QgU0VDUkVUX0FSTiA9IHByb2Nlc3MuZW52LlNFQ1JFVF9BUk4hO1xuY29uc3QgREFUQUJBU0VfTkFNRSA9IHByb2Nlc3MuZW52LkRBVEFCQVNFX05BTUUhO1xuXG5pbnRlcmZhY2UgQmFja2ZpbGxDb25maWcge1xuICBkeW5hbW9UYWJsZTogc3RyaW5nO1xuICBhdXJvcmFUYWJsZTogc3RyaW5nO1xuICBwcmltYXJ5S2V5OiBzdHJpbmdbXTtcbiAgY29sdW1uTWFwcGluZzogeyBba2V5OiBzdHJpbmddOiBzdHJpbmcgfTtcbn1cblxuY29uc3QgVEFCTEVTOiBCYWNrZmlsbENvbmZpZ1tdID0gW1xuICB7XG4gICAgZHluYW1vVGFibGU6ICdzb25nYmlyZC1kZXZpY2VzJyxcbiAgICBhdXJvcmFUYWJsZTogJ2FuYWx5dGljcy5kZXZpY2VzJyxcbiAgICBwcmltYXJ5S2V5OiBbJ3NlcmlhbF9udW1iZXInXSxcbiAgICBjb2x1bW5NYXBwaW5nOiB7XG4gICAgICBzZXJpYWxfbnVtYmVyOiAnc2VyaWFsX251bWJlcicsXG4gICAgICBkZXZpY2VfdWlkOiAnZGV2aWNlX3VpZCcsXG4gICAgICBuYW1lOiAnbmFtZScsXG4gICAgICBmbGVldF9uYW1lOiAnZmxlZXRfbmFtZScsXG4gICAgICBmbGVldF91aWQ6ICdmbGVldF91aWQnLFxuICAgICAgcHJvZHVjdF91aWQ6ICdwcm9kdWN0X3VpZCcsXG4gICAgICBsYXN0X3NlZW46ICdsYXN0X3NlZW4nLFxuICAgICAgbGFzdF9sb2NhdGlvbl9sYXQ6ICdsYXN0X2xvY2F0aW9uX2xhdCcsXG4gICAgICBsYXN0X2xvY2F0aW9uX2xvbjogJ2xhc3RfbG9jYXRpb25fbG9uJyxcbiAgICAgIHN0YXR1czogJ3N0YXR1cycsXG4gICAgICB2b2x0YWdlOiAndm9sdGFnZScsXG4gICAgICB0ZW1wZXJhdHVyZTogJ3RlbXBlcmF0dXJlJyxcbiAgICAgIGNyZWF0ZWRfYXQ6ICdjcmVhdGVkX2F0JyxcbiAgICAgIHVwZGF0ZWRfYXQ6ICd1cGRhdGVkX2F0JyxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgZHluYW1vVGFibGU6ICdzb25nYmlyZC10ZWxlbWV0cnknLFxuICAgIGF1cm9yYVRhYmxlOiAnYW5hbHl0aWNzLnRlbGVtZXRyeScsXG4gICAgcHJpbWFyeUtleTogWydzZXJpYWxfbnVtYmVyJywgJ3RpbWUnXSxcbiAgICBjb2x1bW5NYXBwaW5nOiB7XG4gICAgICBkZXZpY2VfdWlkOiAnZGV2aWNlX3VpZCcsXG4gICAgICBzZXJpYWxfbnVtYmVyOiAnc2VyaWFsX251bWJlcicsXG4gICAgICB0aW1lc3RhbXA6ICd0aW1lJyxcbiAgICAgIHRlbXBlcmF0dXJlOiAndGVtcGVyYXR1cmUnLFxuICAgICAgaHVtaWRpdHk6ICdodW1pZGl0eScsXG4gICAgICBwcmVzc3VyZTogJ3ByZXNzdXJlJyxcbiAgICAgIHZvbHRhZ2U6ICd2b2x0YWdlJyxcbiAgICAgIGV2ZW50X3R5cGU6ICdldmVudF90eXBlJyxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgZHluYW1vVGFibGU6ICdzb25nYmlyZC1sb2NhdGlvbnMnLFxuICAgIGF1cm9yYVRhYmxlOiAnYW5hbHl0aWNzLmxvY2F0aW9ucycsXG4gICAgcHJpbWFyeUtleTogWydzZXJpYWxfbnVtYmVyJywgJ3RpbWUnXSxcbiAgICBjb2x1bW5NYXBwaW5nOiB7XG4gICAgICBkZXZpY2VfdWlkOiAnZGV2aWNlX3VpZCcsXG4gICAgICBzZXJpYWxfbnVtYmVyOiAnc2VyaWFsX251bWJlcicsXG4gICAgICB0aW1lc3RhbXA6ICd0aW1lJyxcbiAgICAgIGxhdGl0dWRlOiAnbGF0JyxcbiAgICAgIGxvbmdpdHVkZTogJ2xvbicsXG4gICAgICBzb3VyY2U6ICdzb3VyY2UnLFxuICAgICAgam91cm5leV9pZDogJ2pvdXJuZXlfaWQnLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBkeW5hbW9UYWJsZTogJ3NvbmdiaXJkLWFsZXJ0cycsXG4gICAgYXVyb3JhVGFibGU6ICdhbmFseXRpY3MuYWxlcnRzJyxcbiAgICBwcmltYXJ5S2V5OiBbJ2FsZXJ0X2lkJ10sXG4gICAgY29sdW1uTWFwcGluZzoge1xuICAgICAgYWxlcnRfaWQ6ICdhbGVydF9pZCcsXG4gICAgICBkZXZpY2VfdWlkOiAnZGV2aWNlX3VpZCcsXG4gICAgICBzZXJpYWxfbnVtYmVyOiAnc2VyaWFsX251bWJlcicsXG4gICAgICBhbGVydF90eXBlOiAnYWxlcnRfdHlwZScsXG4gICAgICBzZXZlcml0eTogJ3NldmVyaXR5JyxcbiAgICAgIG1lc3NhZ2U6ICdtZXNzYWdlJyxcbiAgICAgIGFja25vd2xlZGdlZDogJ2Fja25vd2xlZGdlZCcsXG4gICAgICBjcmVhdGVkX2F0OiAnY3JlYXRlZF9hdCcsXG4gICAgICBhY2tub3dsZWRnZWRfYXQ6ICdhY2tub3dsZWRnZWRfYXQnLFxuICAgICAgYWNrbm93bGVkZ2VkX2J5OiAnYWNrbm93bGVkZ2VkX2J5JyxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgZHluYW1vVGFibGU6ICdzb25nYmlyZC1qb3VybmV5cycsXG4gICAgYXVyb3JhVGFibGU6ICdhbmFseXRpY3Muam91cm5leXMnLFxuICAgIHByaW1hcnlLZXk6IFsnc2VyaWFsX251bWJlcicsICdqb3VybmV5X2lkJ10sXG4gICAgY29sdW1uTWFwcGluZzoge1xuICAgICAgZGV2aWNlX3VpZDogJ2RldmljZV91aWQnLFxuICAgICAgc2VyaWFsX251bWJlcjogJ3NlcmlhbF9udW1iZXInLFxuICAgICAgam91cm5leV9pZDogJ2pvdXJuZXlfaWQnLFxuICAgICAgc3RhcnRfdGltZTogJ3N0YXJ0X3RpbWUnLFxuICAgICAgZW5kX3RpbWU6ICdlbmRfdGltZScsXG4gICAgICBzdGF0dXM6ICdzdGF0dXMnLFxuICAgICAgdG90YWxfZGlzdGFuY2U6ICdkaXN0YW5jZV9rbScsXG4gICAgfSxcbiAgfSxcbl07XG5cbmZ1bmN0aW9uIGJ1aWxkVXBzZXJ0U1FMKGNvbmZpZzogQmFja2ZpbGxDb25maWcsIGl0ZW06IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGNvbHVtbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHZhbHVlczogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IFtzb3VyY2VDb2wsIHRhcmdldENvbF0gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnLmNvbHVtbk1hcHBpbmcpKSB7XG4gICAgY29uc3QgdmFsdWUgPSBpdGVtW3NvdXJjZUNvbF07XG4gICAgaWYgKHZhbHVlICE9PSB1bmRlZmluZWQgJiYgdmFsdWUgIT09IG51bGwpIHtcbiAgICAgIGNvbHVtbnMucHVzaCh0YXJnZXRDb2wpO1xuXG4gICAgICAvLyBIYW5kbGUgdGltZXN0YW1wcyAtIGNvbnZlcnQgdG8gUG9zdGdyZVNRTCB0aW1lc3RhbXAgaWYgbnVtZXJpY1xuICAgICAgaWYgKHRhcmdldENvbCA9PT0gJ3RpbWUnICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgLy8gQ29udmVydCBtaWxsaXNlY29uZHMgdG8gc2Vjb25kcyBpZiBuZWVkZWRcbiAgICAgICAgY29uc3Qgc2Vjb25kcyA9IHZhbHVlID4gOTk5OTk5OTk5OSA/IHZhbHVlIC8gMTAwMCA6IHZhbHVlO1xuICAgICAgICB2YWx1ZXMucHVzaChgVE9fVElNRVNUQU1QKCR7c2Vjb25kc30pYCk7XG4gICAgICB9XG4gICAgICAvLyBIYW5kbGUgYm9vbGVhbnNcbiAgICAgIGVsc2UgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKHZhbHVlID8gJ1RSVUUnIDogJ0ZBTFNFJyk7XG4gICAgICB9XG4gICAgICAvLyBIYW5kbGUgc3RyaW5nc1xuICAgICAgZWxzZSBpZiAodHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICB2YWx1ZXMucHVzaChgJyR7dmFsdWUucmVwbGFjZSgvJy9nLCBcIicnXCIpfSdgKTtcbiAgICAgIH1cbiAgICAgIC8vIEhhbmRsZSBudW1iZXJzXG4gICAgICBlbHNlIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInKSB7XG4gICAgICAgIHZhbHVlcy5wdXNoKFN0cmluZyh2YWx1ZSkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChjb2x1bW5zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgdXBkYXRlQ2xhdXNlcyA9IGNvbHVtbnNcbiAgICAuZmlsdGVyKGNvbCA9PiAhY29uZmlnLnByaW1hcnlLZXkuaW5jbHVkZXMoY29sKSlcbiAgICAubWFwKGNvbCA9PiBgJHtjb2x9ID0gRVhDTFVERUQuJHtjb2x9YClcbiAgICAuam9pbignLCAnKTtcblxuICByZXR1cm4gYFxuICAgIElOU0VSVCBJTlRPICR7Y29uZmlnLmF1cm9yYVRhYmxlfSAoJHtjb2x1bW5zLmpvaW4oJywgJyl9KVxuICAgIFZBTFVFUyAoJHt2YWx1ZXMuam9pbignLCAnKX0pXG4gICAgT04gQ09ORkxJQ1QgKCR7Y29uZmlnLnByaW1hcnlLZXkuam9pbignLCAnKX0pIERPIFVQREFURSBTRVQgJHt1cGRhdGVDbGF1c2VzfVxuICBgO1xufVxuXG5hc3luYyBmdW5jdGlvbiBiYWNrZmlsbFRhYmxlKGNvbmZpZzogQmFja2ZpbGxDb25maWcpOiBQcm9taXNlPHsgdGFibGU6IHN0cmluZzsgY291bnQ6IG51bWJlcjsgZXJyb3JzOiBudW1iZXIgfT4ge1xuICBjb25zb2xlLmxvZyhgQmFja2ZpbGxpbmcgJHtjb25maWcuZHluYW1vVGFibGV9IOKGkiAke2NvbmZpZy5hdXJvcmFUYWJsZX1gKTtcblxuICBsZXQgY291bnQgPSAwO1xuICBsZXQgZXJyb3JzID0gMDtcbiAgbGV0IGxhc3RFdmFsdWF0ZWRLZXk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuXG4gIGRvIHtcbiAgICBjb25zdCBzY2FuUmVzdWx0ID0gYXdhaXQgZGRiLnNlbmQobmV3IFNjYW5Db21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogY29uZmlnLmR5bmFtb1RhYmxlLFxuICAgICAgRXhjbHVzaXZlU3RhcnRLZXk6IGxhc3RFdmFsdWF0ZWRLZXksXG4gICAgICBMaW1pdDogMTAwLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IGl0ZW1zID0gc2NhblJlc3VsdC5JdGVtcyB8fCBbXTtcblxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgICAgY29uc3Qgc3FsID0gYnVpbGRVcHNlcnRTUUwoY29uZmlnLCBpdGVtKTtcbiAgICAgIGlmICghc3FsKSBjb250aW51ZTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcmRzLnNlbmQobmV3IEV4ZWN1dGVTdGF0ZW1lbnRDb21tYW5kKHtcbiAgICAgICAgICByZXNvdXJjZUFybjogQ0xVU1RFUl9BUk4sXG4gICAgICAgICAgc2VjcmV0QXJuOiBTRUNSRVRfQVJOLFxuICAgICAgICAgIGRhdGFiYXNlOiBEQVRBQkFTRV9OQU1FLFxuICAgICAgICAgIHNxbCxcbiAgICAgICAgfSkpO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgICAgZXJyb3JzKys7XG4gICAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1Vua25vd24gZXJyb3InO1xuICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvciBpbnNlcnRpbmcgaW50byAke2NvbmZpZy5hdXJvcmFUYWJsZX06YCwgZXJyb3JNZXNzYWdlKTtcbiAgICAgICAgY29uc29sZS5lcnJvcignU1FMOicsIHNxbC5zdWJzdHJpbmcoMCwgMjAwKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGFzdEV2YWx1YXRlZEtleSA9IHNjYW5SZXN1bHQuTGFzdEV2YWx1YXRlZEtleTtcbiAgICBjb25zb2xlLmxvZyhgICBQcm9jZXNzZWQgJHtjb3VudH0gcmVjb3JkcyBzbyBmYXIuLi5gKTtcblxuICB9IHdoaWxlIChsYXN0RXZhbHVhdGVkS2V5KTtcblxuICBjb25zb2xlLmxvZyhgQ29tcGxldGVkICR7Y29uZmlnLmR5bmFtb1RhYmxlfTogJHtjb3VudH0gcmVjb3JkcywgJHtlcnJvcnN9IGVycm9yc2ApO1xuICByZXR1cm4geyB0YWJsZTogY29uZmlnLmR5bmFtb1RhYmxlLCBjb3VudCwgZXJyb3JzIH07XG59XG5cbmV4cG9ydCBjb25zdCBoYW5kbGVyID0gYXN5bmMgKGV2ZW50OiB7IHRhYmxlcz86IHN0cmluZ1tdIH0pOiBQcm9taXNlPHtcbiAgc3RhdHVzQ29kZTogbnVtYmVyO1xuICBib2R5OiBzdHJpbmc7XG59PiA9PiB7XG4gIGNvbnNvbGUubG9nKCdTdGFydGluZyBhbmFseXRpY3MgYmFja2ZpbGwuLi4nKTtcblxuICBjb25zdCB0YWJsZXNUb1Byb2Nlc3MgPSBldmVudC50YWJsZXNcbiAgICA/IFRBQkxFUy5maWx0ZXIodCA9PiBldmVudC50YWJsZXMhLmluY2x1ZGVzKHQuZHluYW1vVGFibGUpKVxuICAgIDogVEFCTEVTO1xuXG4gIGNvbnN0IHJlc3VsdHMgPSBbXTtcblxuICBmb3IgKGNvbnN0IGNvbmZpZyBvZiB0YWJsZXNUb1Byb2Nlc3MpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYmFja2ZpbGxUYWJsZShjb25maWcpO1xuICAgICAgcmVzdWx0cy5wdXNoKHJlc3VsdCk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ1Vua25vd24gZXJyb3InO1xuICAgICAgY29uc29sZS5lcnJvcihgRmFpbGVkIHRvIGJhY2tmaWxsICR7Y29uZmlnLmR5bmFtb1RhYmxlfTpgLCBlcnJvck1lc3NhZ2UpO1xuICAgICAgcmVzdWx0cy5wdXNoKHsgdGFibGU6IGNvbmZpZy5keW5hbW9UYWJsZSwgY291bnQ6IDAsIGVycm9yczogLTEsIGVycm9yOiBlcnJvck1lc3NhZ2UgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3Qgc3VtbWFyeSA9IHtcbiAgICB0b3RhbFJlY29yZHM6IHJlc3VsdHMucmVkdWNlKChzdW0sIHIpID0+IHN1bSArIHIuY291bnQsIDApLFxuICAgIHRvdGFsRXJyb3JzOiByZXN1bHRzLnJlZHVjZSgoc3VtLCByKSA9PiBzdW0gKyByLmVycm9ycywgMCksXG4gICAgdGFibGVzOiByZXN1bHRzLFxuICB9O1xuXG4gIGNvbnNvbGUubG9nKCdCYWNrZmlsbCBjb21wbGV0ZTonLCBKU09OLnN0cmluZ2lmeShzdW1tYXJ5LCBudWxsLCAyKSk7XG5cbiAgcmV0dXJuIHtcbiAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoc3VtbWFyeSwgbnVsbCwgMiksXG4gIH07XG59O1xuIl19