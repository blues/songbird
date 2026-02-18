---
planStatus:
  planId: plan-arize-phoenix-integration
  title: Arize Phoenix AI Observability Integration
  status: in-development
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - observability
    - ai
    - monitoring
    - bedrock
    - analytics
  created: "2026-02-17"
  updated: "2026-02-18T16:30:00.000Z"
  startDate: "2026-02-18"
  progress: 60
---
# Arize Phoenix Integration Plan

## Implementation Progress

**Note**: Implementation ready to begin. Exit plan mode to create files.

### Phase 1: Phoenix Server Deployment
- [x] Create observability-construct.ts with ECS Fargate infrastructure
- [x] Configure EFS file system for persistent storage
- [x] Set up ALB with HTTPS and gRPC listeners
- [x] Configure security groups and networking
- [x] Create ACM certificate and Route53 DNS record
- [x] Integrate observability construct into main stack
- [x] Update analytics construct to expose VPC
- [ ] Deploy and verify Phoenix service is running

### Phase 2: Lambda Instrumentation
- [x] Install OpenTelemetry dependencies in package.json
- [x] Create shared/tracing.ts instrumentation wrapper
- [x] Instrument analytics Lambda (chat-query.ts)
- [ ] Add custom spans for business logic
- [x] Update Lambda environment variables with Phoenix endpoint
- [x] Grant Lambda network access to Phoenix service

### Phase 3: Dashboard Integration
- [ ] Add Phoenix link to Analytics page
- [ ] Update dashboard config.json with Phoenix URL
- [ ] Deploy dashboard with Phoenix integration

### Phase 4: Testing & Verification
- [ ] Verify ECS task is running and healthy
- [ ] Verify Phoenix UI is accessible
- [ ] Test trace collection from Lambda
- [ ] Verify traces appear in Phoenix UI
- [ ] Performance testing (measure overhead)

## Overview

Integrate **Arize Phoenix** - an open-source AI observability and evaluation platform - into the Songbird application to provide comprehensive monitoring, tracing, and evaluation of the AWS Bedrock (Claude 3.5 Sonnet) integration used for Text-to-SQL analytics.

### What is Arize Phoenix?

Phoenix is an AI observability platform that enables developers to trace, evaluate, and improve AI applications. Built on OpenTelemetry, it provides:

- **Tracing**: Detailed execution logs of LLM calls, showing inputs, outputs, latency, and token usage
- **Evaluation**: Quality measurement through LLM-based evaluators and code-based checks
- **Prompt Engineering**: Iteration on prompts using real production examples
- **Datasets & Experiments**: Systematic testing and comparison of application changes

### Current State: AWS Bedrock Analytics

Songbird currently uses AWS Bedrock (Claude 3.5 Sonnet) for natural language to SQL query conversion in the analytics feature:

**Location**: `songbird-infrastructure/lambda/analytics/chat-query.ts`

**Current Flow**:
1. User asks natural language question (e.g., "Show me temperature spikes in the last week")
2. Lambda invokes Bedrock with schema context, few-shot examples, and user question
3. Claude generates SQL query, visualization type, and explanation
4. Lambda executes SQL against Aurora Serverless v2
5. Lambda invokes Bedrock again to generate insights from results
6. Response returned to dashboard

**Key Metrics Currently Missing**:
- LLM call latency and performance
- Token usage and costs
- SQL generation quality/accuracy
- Prompt effectiveness
- Error patterns and failure modes
- A/B testing for prompt improvements

## Goals

1. **Visibility**: Gain full observability into Bedrock LLM calls (inputs, outputs, latency, tokens)
2. **Quality Monitoring**: Track SQL generation accuracy and identify failure patterns
3. **Cost Optimization**: Monitor token usage to optimize prompt efficiency
4. **Performance Tracking**: Measure end-to-end latency of analytics queries
5. **Continuous Improvement**: Enable prompt engineering workflow with production data
6. **Experimentation**: Support A/B testing of different prompt strategies

## Architecture

### Deployment Model: AWS ECS Fargate (Phoenix Server)

Phoenix will run as a containerized service on AWS ECS Fargate within the existing AWS infrastructure:

```
┌─────────────────────────────────────────────────────────────┐
│                      AWS Cloud                               │
│                                                               │
│  ┌──────────────────────────┐                                │
│  │   ECS Fargate Cluster    │                                │
│  │  ┌────────────────────┐  │                                │
│  │  │  Phoenix Server    │  │◄─── OpenTelemetry traces      │
│  │  │  (Docker)          │  │     (OTLP/gRPC)                │
│  │  │                    │  │                                │
│  │  │  - Phoenix UI      │  │                                │
│  │  │  - OTLP Collector  │  │                                │
│  │  │  - PostgreSQL      │  │                                │
│  │  └────────────────────┘  │                                │
│  └──────────────────────────┘                                │
│           │                                                   │
│           │ ALB (HTTPS)                                       │
│           ▼                                                   │
│  ┌──────────────────────────┐                                │
│  │   CloudFront (Optional)  │                                │
│  └──────────────────────────┘                                │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Lambda: analytics/chat-query                  │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │  @arizeai/phoenix-otel instrumentation        │  │   │
│  │  │  - Auto-instrument Bedrock calls              │  │   │
│  │  │  - Send traces to Phoenix via OTLP            │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │                                                        │   │
│  │  Bedrock Calls:                                       │   │
│  │  1. Generate SQL from question                        │   │
│  │  2. Generate insights from results                    │   │
│  │                                                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Why ECS Fargate?**
- Serverless container platform (no server management)
- Integrates naturally with existing AWS infrastructure
- Scalable and cost-effective
- Easy to configure with existing VPC, security groups, and ALB
- Supports persistent storage via EFS for Phoenix's PostgreSQL database

**Alternative Considered: Docker on EC2**
- Requires managing EC2 instances and patching
- Higher operational overhead
- Less cost-efficient for variable workloads

### Data Flow

1. **Lambda Instrumentation**:
  - `@arizeai/phoenix-otel` package wraps Lambda function
  - Auto-instruments AWS Bedrock SDK calls
  - Captures: model invocations, prompts, completions, latency, token counts

2. **Trace Export**:
  - OpenTelemetry exporter sends traces to Phoenix via OTLP/gRPC
  - Batched for efficiency
  - Environment variable `PHOENIX_COLLECTOR_ENDPOINT` points to Phoenix server

3. **Phoenix Server**:
  - Receives traces via OTLP collector
  - Stores in PostgreSQL (running in same ECS task)
  - Provides web UI for exploration and analysis
  - Supports evaluations and prompt management

4. **Dashboard Access**:
  - Phoenix UI accessible via ALB endpoint (e.g., `https://phoenix.songbird.live`)
  - Authenticated via Cognito (integrate with existing auth)
  - Admin and FieldEngineering groups have read access

## Implementation Steps

### Phase 1: Phoenix Server Deployment (AWS CDK)

**New CDK Construct**: `lib/observability-construct.ts`

#### 1.1: ECS Cluster & Fargate Service

```typescript
// Create ECS cluster
const cluster = new ecs.Cluster(this, 'PhoenixCluster', {
  vpc,
  clusterName: 'songbird-phoenix',
});

// Task definition with Phoenix container
const taskDefinition = new ecs.FargateTaskDefinition(this, 'PhoenixTask', {
  memoryLimitMiB: 2048,
  cpu: 1024,
});

// Phoenix container
const phoenixContainer = taskDefinition.addContainer('phoenix', {
  image: ecs.ContainerImage.fromRegistry('arizephoenix/phoenix:version-8.0.0'),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: 'phoenix',
    logRetention: logs.RetentionDays.TWO_WEEKS,
  }),
  environment: {
    PHOENIX_PORT: '6006',
    PHOENIX_GRPC_PORT: '4317',
    PHOENIX_WORKING_DIR: '/phoenix-data',
  },
  portMappings: [
    { containerPort: 6006, protocol: ecs.Protocol.TCP }, // HTTP UI
    { containerPort: 4317, protocol: ecs.Protocol.TCP }, // OTLP gRPC
  ],
});

// EFS volume for persistent storage
const fileSystem = new efs.FileSystem(this, 'PhoenixFS', {
  vpc,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  encrypted: true,
});

// Mount EFS to task
taskDefinition.addVolume({
  name: 'phoenix-data',
  efsVolumeConfiguration: {
    fileSystemId: fileSystem.fileSystemId,
  },
});

phoenixContainer.addMountPoints({
  sourceVolume: 'phoenix-data',
  containerPath: '/phoenix-data',
  readOnly: false,
});

// Fargate service
const service = new ecs.FargateService(this, 'PhoenixService', {
  cluster,
  taskDefinition,
  desiredCount: 1,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
  securityGroups: [securityGroup],
});
```

#### 1.2: Application Load Balancer

```typescript
const alb = new elbv2.ApplicationLoadBalancer(this, 'PhoenixALB', {
  vpc,
  internetFacing: true,
});

// HTTP UI listener
const httpListener = alb.addListener('HttpListener', {
  port: 443,
  protocol: elbv2.ApplicationProtocol.HTTPS,
  certificates: [certificate],
});

httpListener.addTargets('PhoenixUI', {
  port: 6006,
  targets: [service],
  healthCheck: {
    path: '/healthz',
    interval: cdk.Duration.seconds(30),
  },
});

// gRPC listener for OTLP
const grpcListener = alb.addListener('GrpcListener', {
  port: 4317,
  protocol: elbv2.ApplicationProtocol.HTTP,
});

grpcListener.addTargets('PhoenixOTLP', {
  port: 4317,
  targets: [service],
  protocolVersion: elbv2.ApplicationProtocolVersion.GRPC,
});
```

#### 1.3: Security & Networking

```typescript
// Security group for Phoenix service
const securityGroup = new ec2.SecurityGroup(this, 'PhoenixSG', {
  vpc,
  description: 'Security group for Phoenix observability service',
});

// Allow inbound from ALB
securityGroup.addIngressRule(
  albSecurityGroup,
  ec2.Port.tcp(6006),
  'Allow HTTP UI traffic from ALB'
);

securityGroup.addIngressRule(
  albSecurityGroup,
  ec2.Port.tcp(4317),
  'Allow OTLP gRPC traffic from ALB'
);

// Allow outbound for Lambda to Phoenix communication
lambdaSecurityGroup.connections.allowTo(
  securityGroup,
  ec2.Port.tcp(4317),
  'Allow Lambda to send traces to Phoenix'
);
```

#### 1.4: IAM Permissions

```typescript
// Grant EFS access
fileSystem.grantReadWrite(taskDefinition.taskRole);

// Grant CloudWatch Logs
taskDefinition.taskRole.addManagedPolicy(
  iam.ManagedPolicy.fromAwsManagedPolicyName(
    'CloudWatchLogsFullAccess'
  )
);
```

#### 1.5: DNS & Certificate

```typescript
// Route53 record
new route53.ARecord(this, 'PhoenixDNS', {
  zone: hostedZone,
  recordName: 'phoenix',
  target: route53.RecordTarget.fromAlias(
    new targets.LoadBalancerTarget(alb)
  ),
});

// ACM certificate
const certificate = new acm.Certificate(this, 'PhoenixCert', {
  domainName: 'phoenix.songbird.live',
  validation: acm.CertificateValidation.fromDns(hostedZone),
});
```

### Phase 2: Lambda Instrumentation

#### 2.1: Install Dependencies

**File**: `songbird-infrastructure/package.json`

```json
{
  "dependencies": {
    "@arizeai/phoenix-otel": "^1.0.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/instrumentation": "^0.52.0",
    "@opentelemetry/sdk-trace-node": "^1.25.0",
    "@opentelemetry/exporter-trace-otlp-grpc": "^0.52.0",
    "@opentelemetry/resources": "^1.25.0",
    "@opentelemetry/semantic-conventions": "^1.25.0"
  }
}
```

#### 2.2: Create Instrumentation Wrapper

**New File**: `songbird-infrastructure/lambda/shared/tracing.ts`

```typescript
import { register } from '@arizeai/phoenix-otel';

/**
 * Initialize Phoenix OpenTelemetry tracing
 * Call this at the top of Lambda handler files
 */
export function initializeTracing(serviceName: string) {
  // Only initialize if Phoenix endpoint is configured
  if (!process.env.PHOENIX_COLLECTOR_ENDPOINT) {
    console.warn('PHOENIX_COLLECTOR_ENDPOINT not set, tracing disabled');
    return;
  }

  register({
    serviceName,
    endpoint: process.env.PHOENIX_COLLECTOR_ENDPOINT,
    // Include Lambda context in traces
    resourceAttributes: {
      'cloud.provider': 'aws',
      'cloud.platform': 'aws_lambda',
      'faas.name': process.env.AWS_LAMBDA_FUNCTION_NAME,
      'faas.version': process.env.AWS_LAMBDA_FUNCTION_VERSION,
    },
  });

  console.log(`Phoenix tracing initialized for ${serviceName}`);
}
```

#### 2.3: Instrument Analytics Lambda

**File**: `songbird-infrastructure/lambda/analytics/chat-query.ts`

```typescript
// Add at the very top of the file, before any other imports
import { initializeTracing } from '../shared/tracing';
initializeTracing('songbird-analytics-chat-query');

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
// ... rest of imports

// Existing code continues...
```

#### 2.4: Add Custom Spans for Business Logic

Enhance tracing with custom spans for key operations:

```typescript
import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('songbird-analytics');

async function generateSQL(question: string) {
  const span = tracer.startSpan('generate_sql', {
    attributes: {
      'question.length': question.length,
      'llm.provider': 'bedrock',
      'llm.model': BEDROCK_MODEL_ID,
    },
  });

  try {
    const result = await bedrock.send(new InvokeModelCommand({...}));

    span.setAttribute('sql.generated', true);
    span.setAttribute('sql.length', result.sql.length);

    return result;
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
```

#### 2.5: Update Lambda Environment Variables

**File**: `songbird-infrastructure/lib/analytics-construct.ts`

```typescript
this.chatQueryLambda = new NodejsFunction(this, 'ChatQueryLambda', {
  // ... existing config
  environment: {
    // ... existing env vars
    PHOENIX_COLLECTOR_ENDPOINT: `grpc://${phoenixService.loadBalancer.loadBalancerDnsName}:4317`,
    OTEL_SERVICE_NAME: 'songbird-analytics-chat-query',
  },
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});

// Grant Lambda access to Phoenix service
phoenixService.connections.allowFrom(
  this.chatQueryLambda,
  ec2.Port.tcp(4317),
  'Allow Lambda to send traces'
);
```

### Phase 3: Dashboard Integration

#### 3.1: Add Phoenix Link to Dashboard

**File**: `songbird-dashboard/src/pages/Analytics.tsx`

Add a button/link to Phoenix UI in the analytics page:

```typescript
<div className="flex items-center gap-2">
  <Button
    variant="outline"
    onClick={() => window.open(config.phoenixUrl, '_blank')}
  >
    <Activity className="w-4 h-4 mr-2" />
    View Traces
  </Button>
</div>
```

#### 3.2: Update Dashboard Config

**File**: `songbird-dashboard/public/config.json`

```json
{
  "apiUrl": "https://...",
  "phoenixUrl": "https://phoenix.songbird.live",
  "region": "us-east-1",
  ...
}
```

#### 3.3: Embed Phoenix Insights (Optional)

For advanced integration, embed Phoenix charts/metrics directly in dashboard using Phoenix's TypeScript SDK:

```typescript
import { PhoenixClient } from '@arizeai/phoenix-client';

const client = new PhoenixClient({
  baseUrl: config.phoenixUrl,
});

// Fetch recent traces
const traces = await client.traces.list({
  serviceName: 'songbird-analytics-chat-query',
  limit: 10,
});
```

### Phase 4: Evaluation & Quality Monitoring

#### 4.1: Define SQL Quality Evaluators

Create custom evaluators to measure SQL generation quality:

**New File**: `songbird-infrastructure/lambda/analytics/evaluators.ts`

```typescript
/**
 * Evaluator: Does the generated SQL include device filter?
 */
export function evaluateDeviceFilter(sql: string): {
  score: number;
  passed: boolean;
  explanation: string;
} {
  const hasFilter = sql.includes(':deviceFilter');
  return {
    score: hasFilter ? 1.0 : 0.0,
    passed: hasFilter,
    explanation: hasFilter
      ? 'SQL includes required device filter'
      : 'CRITICAL: Missing device filter - security violation',
  };
}

/**
 * Evaluator: Does SQL follow SELECT-only rule?
 */
export function evaluateReadOnly(sql: string): {
  score: number;
  passed: boolean;
  explanation: string;
} {
  const lowerSQL = sql.toLowerCase();
  const dangerous = ['insert', 'update', 'delete', 'drop', 'truncate'];
  const violations = dangerous.filter(kw => lowerSQL.includes(kw));

  return {
    score: violations.length === 0 ? 1.0 : 0.0,
    passed: violations.length === 0,
    explanation: violations.length === 0
      ? 'SQL is read-only'
      : `Contains dangerous keywords: ${violations.join(', ')}`,
  };
}

/**
 * Evaluator: Did the query execute successfully?
 */
export function evaluateExecution(error: Error | null): {
  score: number;
  passed: boolean;
  explanation: string;
} {
  return {
    score: error ? 0.0 : 1.0,
    passed: !error,
    explanation: error ? `Execution failed: ${error.message}` : 'Query executed successfully',
  };
}
```

#### 4.2: Send Evaluations to Phoenix

```typescript
import { trace } from '@opentelemetry/api';

async function processQuery(question: string) {
  const span = tracer.startSpan('analytics_query');

  try {
    // Generate SQL
    const { sql } = await generateSQL(question);

    // Run evaluators
    const filterEval = evaluateDeviceFilter(sql);
    const readOnlyEval = evaluateReadOnly(sql);

    // Attach evaluation results as span attributes
    span.setAttributes({
      'eval.device_filter.score': filterEval.score,
      'eval.device_filter.passed': filterEval.passed,
      'eval.read_only.score': readOnlyEval.score,
      'eval.read_only.passed': readOnlyEval.passed,
    });

    // Execute query
    let execError = null;
    try {
      const data = await executeQuery(sql, deviceSerialNumbers);
    } catch (err) {
      execError = err;
    }

    const execEval = evaluateExecution(execError);
    span.setAttributes({
      'eval.execution.score': execEval.score,
      'eval.execution.passed': execEval.passed,
    });

    // Overall quality score
    const overallScore = (filterEval.score + readOnlyEval.score + execEval.score) / 3;
    span.setAttribute('eval.overall_quality', overallScore);

    return { sql, data };
  } finally {
    span.end();
  }
}
```

#### 4.3: Phoenix UI - Create Evaluation Dashboard

Within Phoenix UI:
1. Navigate to **Evaluations** tab
2. Create custom evaluation dashboard with:
  - SQL quality score over time (line chart)
  - Pass rate for device filter check (gauge)
  - Execution success rate (gauge)
  - Failed queries table (for debugging)

### Phase 5: Cost Optimization & Monitoring

#### 5.1: Track Token Usage

```typescript
span.setAttributes({
  'llm.usage.prompt_tokens': responseBody.usage?.input_tokens || 0,
  'llm.usage.completion_tokens': responseBody.usage?.output_tokens || 0,
  'llm.usage.total_tokens':
    (responseBody.usage?.input_tokens || 0) +
    (responseBody.usage?.output_tokens || 0),
});

// Calculate estimated cost (Claude 3.5 Sonnet pricing)
const promptCost = (responseBody.usage?.input_tokens || 0) * 0.000003; // $3 per 1M tokens
const completionCost = (responseBody.usage?.output_tokens || 0) * 0.000015; // $15 per 1M tokens
const totalCost = promptCost + completionCost;

span.setAttribute('llm.cost_usd', totalCost);
```

#### 5.2: Create Cost Alert

Set up CloudWatch alarm for high token usage:

```typescript
const tokenUsageMetric = new cloudwatch.Metric({
  namespace: 'Songbird/Analytics',
  metricName: 'BedrockTokens',
  statistic: 'Sum',
  period: cdk.Duration.hours(1),
});

new cloudwatch.Alarm(this, 'HighTokenUsage', {
  metric: tokenUsageMetric,
  threshold: 1000000, // 1M tokens per hour
  evaluationPeriods: 1,
  alarmDescription: 'Alert when Bedrock token usage exceeds threshold',
});
```

#### 5.3: Phoenix Cost Dashboard

Create Phoenix dashboard showing:
- Token usage per hour (stacked area: prompt vs completion)
- Estimated cost per day
- Cost per query
- Most expensive queries (top 10)

## Testing Plan

### 1. Infrastructure Testing

**Deploy Phoenix Service**:
```bash
cd songbird-infrastructure
npm run deploy
```

**Verify**:
- [ ] ECS task running and healthy
- [ ] ALB health checks passing
- [ ] Phoenix UI accessible at https://phoenix.songbird.live
- [ ] OTLP endpoint responding (test with curl)

### 2. Lambda Instrumentation Testing

**Test Trace Collection**:
```bash
# Invoke analytics Lambda
curl -X POST https://api.songbird.live/analytics/chat \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"question": "Show me recent temperatures"}'

# Check Phoenix UI for new traces
```

**Verify**:
- [ ] Traces appear in Phoenix UI within 30 seconds
- [ ] Bedrock spans show input prompts
- [ ] Bedrock spans show output SQL
- [ ] Token counts are captured
- [ ] Custom spans appear (generate_sql, execute_query)

### 3. Evaluation Testing

**Verify Evaluations**:
- [ ] Device filter evaluation runs and passes
- [ ] Read-only evaluation runs and passes
- [ ] Execution evaluation runs
- [ ] Evaluation scores visible in Phoenix UI

### 4. Performance Testing

**Measure Overhead**:
- Baseline: Lambda execution time without tracing
- With tracing: Lambda execution time with Phoenix instrumentation
- Acceptable overhead: < 50ms per invocation

**Load Test**:
- Send 100 concurrent analytics requests
- Verify traces are captured without data loss
- Verify Phoenix service scales appropriately

### 5. Dashboard Integration Testing

**Verify**:
- [ ] Phoenix link in dashboard works
- [ ] Link opens Phoenix UI in new tab
- [ ] User can see traces for their own queries

## Rollout Strategy

### Stage 1: Canary Deployment (Week 1)

- Deploy Phoenix infrastructure
- Instrument analytics Lambda with tracing
- Enable for Admin users only (via feature flag)
- Monitor for errors and performance impact

**Success Criteria**:
- No increase in Lambda errors
- < 50ms latency overhead
- 100% trace capture rate

### Stage 2: Gradual Rollout (Week 2)

- Enable for FieldEngineering group
- Add evaluation metrics
- Gather feedback on Phoenix UI usability

**Success Criteria**:
- Positive user feedback
- No performance degradation
- Evaluations running successfully

### Stage 3: Full Production (Week 3)

- Enable for all users
- Set up cost monitoring alerts
- Document observability workflows
- Train team on using Phoenix for debugging

**Success Criteria**:
- All analytics queries traced
- Cost within budget (<$50/month for Phoenix infra)
- Team actively using Phoenix for debugging

## Cost Estimation

### Phoenix Infrastructure (ECS Fargate)

| Component | Specification | Monthly Cost |
| --- | --- | --- |
| Fargate vCPU | 1 vCPU × 730 hrs | $29.57 |
| Fargate Memory | 2 GB × 730 hrs | $6.49 |
| EFS Storage | 5 GB (estimated) | $1.50 |
| ALB | 1 ALB × 730 hrs | $16.20 |
| ALB LCU | ~5 LCU (estimated) | $4.05 |
| Data Transfer | 10 GB out (estimated) | $0.90 |
| **Total** |  | **\~$58/month** |

### Tracing Overhead

- OpenTelemetry library: No cost
- Lambda compute overhead: < 1% increase (minimal)
- Egress to Phoenix: Included in VPC (no NAT costs within same VPC)

### Total Monthly Cost: ~$60

## Open Questions

1. **Authentication**: Should Phoenix UI use Cognito integration or separate auth?
  - **Recommendation**: Use ALB + Cognito for unified auth experience

2. **Data Retention**: How long should traces be stored?
  - **Recommendation**: 30 days (configurable via Phoenix env var)

3. **Multi-region**: If Songbird expands to multiple regions, deploy Phoenix per-region or centralized?
  - **Recommendation**: Start with single region, evaluate based on trace volume

4. **Real-time alerts**: Should Phoenix trigger alerts on evaluation failures?
  - **Recommendation**: Phase 2 - integrate Phoenix with SNS for critical eval failures

## Success Metrics

### Operational Metrics

- **Trace Capture Rate**: > 99% of Bedrock calls traced
- **Latency Overhead**: < 50ms per Lambda invocation
- **Uptime**: Phoenix service > 99.5% availability

### Business Metrics

- **SQL Quality**: > 95% of generated queries pass all evaluations
- **Cost Optimization**: Reduce token usage by 20% within 3 months (via prompt optimization)
- **Debugging Speed**: Reduce time to debug analytics issues by 50%

### Adoption Metrics

- **Active Users**: > 80% of Admin/Engineering users access Phoenix UI monthly
- **Evaluation Creation**: Team creates 5+ custom evaluators within 3 months

## Documentation Requirements

1. **Developer Guide**: "Using Phoenix for AI Observability"
  - How to access Phoenix UI
  - How to filter and search traces
  - How to create custom evaluations

2. **Runbook**: "Troubleshooting Phoenix Service"
  - Common issues and resolutions
  - How to check ECS task health
  - How to access Phoenix logs

3. **Prompt Engineering Workflow**:
  - How to use Phoenix to iterate on prompts
  - How to A/B test prompt variations
  - How to measure prompt effectiveness

4. **Cost Monitoring Guide**:
  - How to track Bedrock token usage
  - How to identify expensive queries
  - How to optimize prompts for cost

## Alternative Approaches Considered

### 1. Langfuse (Alternative Observability Platform)

**Pros**:
- Open source
- Similar features to Phoenix
- Good TypeScript support

**Cons**:
- Less mature than Phoenix
- Smaller community
- Fewer integrations

**Decision**: Phoenix chosen for better documentation and AWS Bedrock support

### 2. CloudWatch + Custom Metrics

**Pros**:
- Native AWS service
- No additional infrastructure
- Integrated billing

**Cons**:
- Limited LLM-specific features
- No prompt management
- No evaluation framework
- Poor visualization for traces

**Decision**: CloudWatch insufficient for AI observability needs

### 3. AWS X-Ray

**Pros**:
- Native AWS tracing
- Lambda auto-instrumentation
- No additional infrastructure

**Cons**:
- Not AI-aware (no LLM-specific attributes)
- No prompt engineering features
- No evaluation framework
- Limited visualization

**Decision**: X-Ray is for general distributed tracing, not AI observability

## Next Steps

1. **User Confirmation**: Approve this plan and deployment model
2. **Resource Allocation**: Confirm AWS account has capacity for additional ECS resources
3. **DNS Setup**: Determine subdomain for Phoenix UI (e.g., `phoenix.songbird.live`)
4. **Begin Implementation**: Start with Phase 1 (Phoenix deployment)

## References

- [Arize Phoenix Documentation](https://arize.com/docs/phoenix)
- [Phoenix TypeScript SDK](https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview)
- [OpenTelemetry Node.js Setup](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/javascript)
- [Phoenix Docker Deployment](https://arize.com/docs/phoenix/deployment/docker)
- [OpenInference Instrumentation](https://github.com/Arize-ai/openinference)
