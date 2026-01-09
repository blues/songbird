#!/bin/bash

# Get the cluster ARN and secret ARN from CloudFormation
CLUSTER_ARN=$(aws cloudformation describe-stacks --stack-name SongbirdStack --query "Stacks[0].Outputs[?contains(OutputKey, 'ClusterArn')].OutputValue" --output text 2>/dev/null)
SECRET_ARN=$(aws cloudformation describe-stacks --stack-name SongbirdStack --query "Stacks[0].Outputs[?contains(OutputKey, 'SecretArn')].OutputValue" --output text 2>/dev/null)

# If not found in outputs, try to get from resources
if [ -z "$CLUSTER_ARN" ]; then
  CLUSTER_ARN=$(aws rds describe-db-clusters --query "DBClusters[?contains(DBClusterIdentifier, 'analytics')].DBClusterArn" --output text | head -1)
fi

if [ -z "$SECRET_ARN" ]; then
  SECRET_ARN=$(aws secretsmanager list-secrets --query "SecretList[?contains(Name, 'AnalyticsCluster')].ARN" --output text | head -1)
fi

echo "Cluster ARN: $CLUSTER_ARN"
echo "Secret ARN: $SECRET_ARN"
echo ""

run_query() {
  echo "=== $1 ==="
  aws rds-data execute-statement \
    --resource-arn "$CLUSTER_ARN" \
    --secret-arn "$SECRET_ARN" \
    --database "songbird_analytics" \
    --sql "$2" \
    --output json | jq -r '.records[] | @json' 2>/dev/null || echo "No results or error"
  echo ""
}

echo "Running diagnostic queries..."
echo ""

run_query "Count devices" "SELECT COUNT(*) as count FROM analytics.devices"

run_query "Count telemetry" "SELECT COUNT(*) as count FROM analytics.telemetry"

run_query "Count locations" "SELECT COUNT(*) as count FROM analytics.locations"

run_query "Sample devices" "SELECT serial_number, device_uid, name, status FROM analytics.devices LIMIT 5"

run_query "Sample telemetry (recent)" "SELECT serial_number, time, temperature, humidity, voltage FROM analytics.telemetry ORDER BY time DESC LIMIT 5"

run_query "Telemetry time range" "SELECT MIN(time) as earliest, MAX(time) as latest FROM analytics.telemetry"

run_query "Telemetry with temperature" "SELECT COUNT(*) as count FROM analytics.telemetry WHERE temperature IS NOT NULL"
