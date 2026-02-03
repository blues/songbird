# Songbird Analytics Feature - Deployment Guide

## Overview

This guide walks through deploying the Text-to-SQL Analytics feature powered by AWS Bedrock (Claude) and Aurora Serverless v2.

## Architecture Components

1. **Aurora Serverless v2 (PostgreSQL)** - SQL database for analytics queries
2. **DynamoDB Streams → Aurora Sync** - Real-time data synchronization
3. **AWS Bedrock (Claude)** - LLM for Text-to-SQL and insights generation
4. **Chat API Lambda** - Handles query processing
5. **Chat History Lambda** - Retrieves conversation history
6. **React UI** - Analytics page with chat interface

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 18+ installed
- AWS CDK CLI installed: `npm install -g aws-cdk`
- Existing Songbird infrastructure deployed
- AWS Bedrock enabled in your account (us-east-1 recommended)

### Enable AWS Bedrock

1. Go to AWS Console → Bedrock → Model access
2. Request access to **Anthropic Claude 3.5 Sonnet**
3. Wait for approval (usually instant for most accounts)

## Step 1: Update Main CDK Stack

Update `songbird-infrastructure/lib/songbird-stack.ts` to include the Analytics construct:

```typescript
import { AnalyticsConstruct } from './analytics-construct';

// In your stack constructor, after creating other constructs:

const analytics = new AnalyticsConstruct(this, 'Analytics', {
  devicesTable: storage.devicesTable,
  telemetryTable: storage.telemetryTable,
  locationsTable: storage.locationsTable,
  alertsTable: storage.alertsTable,
  journeysTable: storage.journeysTable,
  powerTable: storage.powerTable,
});

// Add analytics endpoints to API Gateway
api.addAnalyticsRoutes(analytics.chatQueryLambda, analytics.chatHistoryLambda);
```

## Step 2: Update API Construct

Add analytics routes to `songbird-infrastructure/lib/api-construct.ts`:

```typescript
// Add to ApiConstruct class:

public addAnalyticsRoutes(
  chatQueryLambda: lambda.Function,
  chatHistoryLambda: lambda.Function
) {
  const chatQueryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
    'ChatQueryIntegration',
    chatQueryLambda
  );

  const chatHistoryIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
    'ChatHistoryIntegration',
    chatHistoryLambda
  );

  // POST /analytics/chat - Execute analytics query
  this.api.addRoutes({
    path: '/analytics/chat',
    methods: [apigateway.HttpMethod.POST],
    integration: chatQueryIntegration,
    authorizer: this.authorizer,
  });

  // GET /analytics/history - Get chat history
  this.api.addRoutes({
    path: '/analytics/history',
    methods: [apigateway.HttpMethod.GET],
    integration: chatHistoryIntegration,
    authorizer: this.authorizer,
  });
}
```

## Step 3: Enable DynamoDB Streams

Ensure all tables have streams enabled. Update `songbird-infrastructure/lib/storage-construct.ts`:

```typescript
// For each table (devices, telemetry, etc.), add:
stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
```

## Step 4: Deploy Infrastructure

```bash
cd songbird-infrastructure

# Install dependencies
npm install

# Bootstrap CDK (if not done already)
npx cdk bootstrap

# Synthesize to check for errors
npx cdk synth

# Deploy all stacks
npx cdk deploy --all

# Note the outputs:
# - ClusterEndpoint
# - SecretArn
# - ChatHistoryTableName
```

## Step 5: Initialize Aurora Schema

After deployment, run the schema initialization Lambda manually:

```bash
aws lambda invoke \
  --function-name SongbirdStack-AnalyticsInitSchemaLambda-XXXXX \
  --region us-east-1 \
  response.json

cat response.json
```

This creates the analytics schema and partitioned tables.

## Step 6: Backfill Historical Data (Optional)

If you have existing data in DynamoDB, trigger a backfill:

```bash
# Create a script to scan DynamoDB and send records to sync Lambda
# Or manually export DynamoDB to S3 and import to Aurora

# Example: Trigger sync for all devices
aws dynamodb scan \
  --table-name Devices \
  --output json \
  | jq '.Items' \
  | # Process and send to sync Lambda
```

## Step 7: Test Backend

Test the chat API endpoint:

```bash
# Get Cognito token (replace with your user credentials)
COGNITO_TOKEN=$(aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH \
  --client-id YOUR_CLIENT_ID \
  --auth-parameters USERNAME=user@example.com,PASSWORD=yourpassword \
  --query 'AuthenticationResult.IdToken' \
  --output text)

# Test chat query
curl -X POST https://YOUR_API_URL/analytics/chat \
  -H "Authorization: Bearer $COGNITO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Show me all devices",
    "sessionId": "test-session",
    "userEmail": "user@example.com"
  }'

# Test chat history
curl https://YOUR_API_URL/analytics/history?userEmail=user@example.com \
  -H "Authorization: Bearer $COGNITO_TOKEN"
```

## Step 8: Deploy Dashboard

```bash
cd songbird-dashboard

# Install dependencies (if not done)
npm install

# Build
npm run build

# Deploy to S3 (or use existing CI/CD)
aws s3 sync dist/ s3://YOUR_DASHBOARD_BUCKET/

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/*"
```

## Step 9: Test Frontend

1. Navigate to `https://your-dashboard.com/analytics`
2. Try suggested questions
3. Ask: "Show me all my devices"
4. Verify SQL query generation and visualization
5. Check chat history persistence

## Step 10: Monitor & Optimize

### CloudWatch Metrics

Monitor these key metrics:

```bash
# Bedrock invocations
aws cloudwatch get-metric-statistics \
  --namespace AWS/Bedrock \
  --metric-name InvokeModel \
  --dimensions Name=ModelId,Value=anthropic.claude-3-5-sonnet-20241022-v2:0 \
  --start-time 2024-01-01T00:00:00Z \
  --end-time 2024-01-02T00:00:00Z \
  --period 3600 \
  --statistics Sum

# Aurora query performance
aws rds describe-db-cluster-performance-insights \
  --db-cluster-identifier songbird-analytics-cluster

# Lambda errors
aws logs tail /aws/lambda/ChatQueryLambda --follow
```

### Cost Monitoring

Estimated monthly costs (100 queries/day):

| Service | Cost |
|---------|------|
| Aurora Serverless v2 (0.5-4 ACUs) | $40-320 |
| Bedrock Claude invocations | $20-50 |
| Lambda executions | $5 |
| DynamoDB Streams | $2 |
| Data transfer | $5 |
| **Total** | **~$72-382/month** |

### Performance Optimization

1. **Aurora Query Caching**
   - Common queries are cached at PostgreSQL level
   - Query plans are cached for repeated patterns

2. **Partition Pruning**
   - Time-based partitions on telemetry, locations, power tables
   - Queries with time ranges use partition elimination

3. **Index Optimization**
   ```sql
   -- Check slow queries
   SELECT * FROM pg_stat_statements
   ORDER BY mean_exec_time DESC
   LIMIT 10;

   -- Add indexes as needed
   CREATE INDEX IF NOT EXISTS idx_telemetry_device_time
   ON analytics.telemetry(serial_number, time DESC);
   ```

4. **Bedrock Prompt Caching** (Claude 3.5 feature)
   - System prompts are cached automatically
   - Reduces cost by ~90% for repeated context

## Troubleshooting

### Issue: Bedrock Access Denied

```bash
# Check model access
aws bedrock list-foundation-models --region us-east-1

# Request access if needed
aws bedrock put-model-invocation-logging-configuration \
  --logging-config cloudWatchConfig={logGroupName=/aws/bedrock/modelinvocations,roleArn=arn:aws:iam::ACCOUNT:role/BedrockLoggingRole}
```

### Issue: Aurora Connection Timeout

```bash
# Check VPC security groups
aws ec2 describe-security-groups \
  --filters Name=group-name,Values=*Analytics*

# Verify Lambda is in VPC
aws lambda get-function-configuration \
  --function-name ChatQueryLambda \
  --query 'VpcConfig'

# Check Aurora cluster status
aws rds describe-db-clusters \
  --db-cluster-identifier songbird-analytics-cluster
```

### Issue: DynamoDB Sync Not Working

```bash
# Check stream configuration
aws dynamodb describe-table \
  --table-name Devices \
  --query 'Table.StreamSpecification'

# Check sync Lambda errors
aws logs tail /aws/lambda/SyncLambda --follow

# Verify event source mapping
aws lambda list-event-source-mappings \
  --function-name SyncLambda
```

### Issue: SQL Generation Errors

Common issues and solutions:

1. **Table not found**
   - Run schema initialization Lambda again
   - Check Aurora connection from Lambda

2. **Permission denied**
   - Verify Lambda has RDS Data API access
   - Check IAM role has `rds-data:ExecuteStatement`

3. **Invalid SQL syntax**
   - Check Bedrock model version
   - Review schema context in prompt
   - Add more few-shot examples

## Security Considerations

1. **Row-Level Security**: All queries automatically filter by user's devices
2. **SQL Injection Prevention**: Query validation blocks dangerous keywords
3. **Rate Limiting**: Consider adding API Gateway throttling
4. **Audit Logging**: All queries logged to CloudWatch
5. **Data Encryption**: Aurora encrypted at rest, TLS in transit

## Maintenance Tasks

### Monthly

- Review slow queries in `pg_stat_statements`
- Check partition coverage (extend for future dates)
- Analyze Bedrock costs and optimize prompts
- Review chat history retention (90 days TTL)

### Quarterly

- Update Bedrock model version if new Claude released
- Optimize Aurora ACU settings based on usage
- Review and update few-shot examples based on common queries

## Advanced Features (Future Enhancements)

1. **Streaming Responses**: Use Bedrock streaming for real-time answers
2. **Multi-Modal**: Add support for analyzing chart images
3. **Natural Language to Dashboard**: Generate custom dashboards from descriptions
4. **Anomaly Detection**: Proactive alerts for unusual patterns
5. **Query Suggestions**: ML-powered autocomplete for queries
6. **Export Results**: Download query results as CSV/Excel

## Support

For issues or questions:
- Check CloudWatch Logs for Lambda errors
- Review Aurora performance insights
- Test queries directly in Aurora using Query Editor
- Contact Blues support with CloudWatch request IDs

---

## Quick Reference Commands

```bash
# Deploy infrastructure
cd songbird-infrastructure && npx cdk deploy --all

# View logs
aws logs tail /aws/lambda/ChatQueryLambda --follow

# Query Aurora directly
aws rds-data execute-statement \
  --resource-arn $CLUSTER_ARN \
  --secret-arn $SECRET_ARN \
  --database songbird_analytics \
  --sql "SELECT COUNT(*) FROM analytics.devices"

# Check Bedrock usage
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter file://bedrock-filter.json

# Invalidate cache
aws cloudfront create-invalidation \
  --distribution-id $DIST_ID \
  --paths "/analytics/*"
```

---

**Deployment Complete!** 🎉

Navigate to `/analytics` in your dashboard to start asking questions about your Songbird devices.
