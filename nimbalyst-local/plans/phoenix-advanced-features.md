---
planStatus:
  planId: plan-phoenix-advanced-features
  title: Arize Phoenix Advanced Features Integration
  status: draft
  planType: feature
  priority: medium
  owner: satch
  stakeholders: []
  tags:
    - observability
    - analytics
    - llm
    - phoenix
    - evaluation
  created: "2026-02-19"
  updated: "2026-02-19T00:00:00.000Z"
  progress: 0
---
# Arize Phoenix Advanced Features Integration Plan

## Overview

This plan identifies opportunities to leverage Arize Phoenix's extensive feature set beyond basic tracing. Phoenix is currently integrated in Songbird for basic OpenTelemetry trace collection from the analytics chat-query Lambda. This plan explores advanced capabilities that could significantly enhance LLM observability, evaluation, and optimization workflows.

## Current State

### What We Have
- **Phoenix Server**: Deployed on ECS Fargate with ALB, EFS persistence
- **Basic Tracing**: OpenTelemetry traces from `chat-query` Lambda
  - Bedrock LLM calls (SQL generation, insights generation)
  - Span attributes: prompts, responses, token usage, latency
- **Infrastructure**: VPC, security groups, HTTPS endpoint, OTLP HTTP endpoint (port 4318)
- **Storage**: EFS-backed SQLite database

### Current Limitations
- Only one Lambda function traces (chat-query)
- No evaluations, experiments, or datasets
- No prompt management or versioning
- No cost tracking dashboard
- No annotation or human feedback collection
- No retrieval analysis (despite having RAG-like analytics queries)
- Phoenix UI accessed manually, not integrated into Songbird dashboard

---

## Feature Categories & Implementation Opportunities

### 1. EVALUATION SYSTEM

#### 1.1 Automated Query Quality Evaluation
**What This Enables:**
- Automatically assess quality of generated SQL queries
- Detect hallucinations (invalid SQL, non-existent tables/columns)
- Measure relevance of insights to user questions
- Track evaluation metrics over time

**How To Implement:**
1. **Create Custom Evaluators**
  - SQL Syntax Validator (code-based evaluator)
    - Check for valid PostgreSQL syntax
    - Verify referenced tables exist in schema
    - Ensure required device filter is present
  - SQL Execution Success (code-based evaluator)
    - Boolean: did query execute without error?
  - Insight Relevance (LLM-as-judge evaluator)
    - Does the insight answer the user's question?
    - Template: "Given question '{question}' and insight '{insight}', rate relevance 1-5"
  - Hallucination Detection (pre-built evaluator)
    - Use Phoenix's `HallucinationEvaluator`
    - Inputs: user question, SQL query, schema context

2. **Run Evaluations on Production Traces**
  - Use Phoenix REST API to fetch spans with `llm.vendor=aws-bedrock`
  - Extract inputs/outputs from span attributes
  - Run evaluators via `phoenix.evals` Python SDK
  - Push evaluation results back to Phoenix

3. **Scheduled Evaluation Jobs**
  - New Lambda function: `songbird-analytics-evaluate`
  - Triggered daily via EventBridge
  - Evaluates last 24h of chat traces
  - Stores evaluation results in Phoenix

4. **Dashboard Integration**
  - Add "Query Quality" widget to Songbird dashboard
  - Show evaluation metrics: success rate, avg relevance, hallucination rate
  - Link to Phoenix UI for detailed analysis

**Technical Requirements:**
- New Lambda: `lambda/analytics/evaluate-traces.ts`
- Dependencies: `arize-phoenix-client`, `arize-phoenix-evals`
- EventBridge rule for scheduling
- Update analytics construct with evaluation Lambda

**Value Delivered:**
- Catch SQL generation errors before users see them
- Measure LLM performance quantitatively
- Identify prompt improvements needed
- Build confidence in AI-generated queries

---

#### 1.2 Batch Evaluation Framework
**What This Enables:**
- Test prompt changes across historical queries before deploying
- Compare different LLM models (Claude 3.5 vs 3.7)
- A/B test prompt templates
- Prevent regressions

**How To Implement:**
1. **Create Golden Dataset**
  - Curate 50-100 exemplary queries from production traces
  - Include edge cases, complex queries, failure scenarios
  - Store as Phoenix dataset with expected outputs

2. **Experiment Workflow**
  - Before deploying prompt changes:
    - Run new prompt through golden dataset
    - Compare evaluation scores vs. baseline
    - Require ≥95% pass rate to deploy

3. **Implementation**
  - Python script: `scripts/run_analytics_evaluation.py`
  - Uses `run_experiment()` from Phoenix SDK
  - Invokes Bedrock with test prompts
  - Returns pass/fail with detailed report

4. **CI/CD Integration**
  - GitHub Action runs evaluation on PR to `chat-query.ts`
  - Comments on PR with evaluation results
  - Blocks merge if scores regress significantly

**Technical Requirements:**
- Script: `scripts/run_analytics_evaluation.py`
- GitHub Actions workflow: `.github/workflows/evaluate-analytics.yml`
- Dataset stored in Phoenix Cloud or self-hosted Phoenix
- Access to AWS Bedrock from CI (use GitHub OIDC)

**Value Delivered:**
- Safe prompt iteration without production risk
- Quantitative basis for LLM/prompt selection decisions
- Catch regressions before deployment
- Build organizational trust in AI changes

---

### 2. DATASET MANAGEMENT

#### 2.1 Curated Test Cases from Production
**What This Enables:**
- Build test suite from real user queries
- Preserve anonymized production queries for testing
- Create regression test suite
- Enable reproducible evaluation

**How To Implement:**
1. **Dataset Creation Workflow**
  - Admin reviews Phoenix traces
  - Selects high-quality examples (correct SQL, good insights)
  - Clicks "Add to Dataset" in Phoenix UI
  - Assigns to dataset: "analytics-golden-queries"

2. **Programmatic Dataset Creation**
  - Lambda function: `songbird-analytics-dataset-curator`
  - Triggered weekly via EventBridge
  - Queries ChatHistory DynamoDB table
  - Filters for high-quality queries (user feedback, no errors)
  - Pushes to Phoenix dataset via REST API

3. **Dataset Versioning**
  - Tag datasets with timestamps: "golden-queries-2026-02-19"
  - Track dataset evolution over time
  - Link to specific experiment runs

**Technical Requirements:**
- New Lambda: `lambda/analytics/curate-dataset.ts`
- Phoenix REST API integration
- DynamoDB query with filters (need user feedback column)
- Dataset management UI in Phoenix

**Value Delivered:**
- Real-world test cases vs. synthetic ones
- Continuously improving test coverage
- Reproducible evaluations across time
- Faster debugging with known-good examples

---

#### 2.2 Dataset Export for Fine-Tuning
**What This Enables:**
- Export high-quality SQL examples for model fine-tuning
- Create training data for domain-specific SQL model
- Reduce inference costs by using smaller fine-tuned model

**How To Implement:**
1. **Export Pipeline**
  - Script: `scripts/export_sql_training_data.py`
  - Queries Phoenix for high-rated SQL generation traces
  - Formats as JSONL for fine-tuning APIs
  - Schema: `{"prompt": "...", "completion": "{\"sql\": \"...\"}"}`

2. **Fine-Tuning Workflow**
  - Export dataset (≥500 examples)
  - Upload to OpenAI/Anthropic fine-tuning API
  - Train custom model
  - Update `BEDROCK_MODEL_ID` to use fine-tuned model

3. **Comparison Experiment**
  - Run experiment: base model vs. fine-tuned model
  - Evaluate on holdout dataset
  - Measure: accuracy, latency, cost
  - Document ROI (cost savings vs. fine-tuning cost)

**Technical Requirements:**
- Export script with Phoenix SDK
- Access to fine-tuning APIs
- Budget for fine-tuning (varies by provider)
- A/B test infrastructure

**Value Delivered:**
- Potential 50-90% cost reduction (Haiku fine-tuned vs. Sonnet)
- Faster inference (smaller models)
- Domain-specific SQL expertise
- Long-term cost optimization

---

### 3. EXPERIMENTS & PROMPT OPTIMIZATION

#### 3.1 Prompt Engineering Playground
**What This Enables:**
- Test prompt variations side-by-side
- Compare LLM providers (Bedrock Claude, OpenAI, Vertex)
- Optimize system prompts without deploying
- Share prompt experiments with team

**How To Implement:**
1. **Phoenix Playground Integration**
  - Access Phoenix UI at `https://phoenix.songbird.live/playground`
  - Load production trace (span replay feature)
  - Edit system prompt, few-shot examples
  - Run against multiple models simultaneously
  - Compare outputs and latency

2. **Prompt Versioning**
  - Store prompts in Phoenix Prompt Hub
  - Tag with semantic versions: "sql-generation-v1.0"
  - Link prompt version to Lambda deployments
  - Track which prompt version generated which traces

3. **Prompt Templates**
  - Refactor `SCHEMA_CONTEXT` and `TASK_PROMPT` as templates
  - Store in Phoenix with variables: `{schema}`, `{examples}`
  - Fetch at Lambda cold start, cache
  - Enable prompt updates without redeployment

4. **Meta-Prompting**
  - Use Phoenix's automatic prompt optimization
  - Analyzes failed traces
  - Suggests prompt improvements via LLM
  - Human reviews and commits to Prompt Hub

**Technical Requirements:**
- Modify `chat-query.ts` to fetch prompts from Phoenix API
- Lambda environment variables: `PHOENIX_PROMPT_ID=sql-generation-v2`
- Phoenix Prompt Hub setup
- Caching strategy to avoid API calls per request

**Value Delivered:**
- Faster prompt iteration (minutes vs. hours with deployments)
- Systematic prompt improvement
- Team collaboration on prompts
- Reproducible experiments with prompt versions

---

#### 3.2 Multi-Model A/B Testing
**What This Enables:**
- Compare cost vs. quality across LLM providers
- Find optimal model for SQL generation vs. insights generation
- Test new models as they release

**How To Implement:**
1. **Traffic Splitting**
  - Modify `chat-query.ts` to select model based on session hash
  - 50% Sonnet, 25% Haiku, 25% Opus
  - Tag spans with `experiment.variant=sonnet|haiku|opus`

2. **Phoenix Experiment Tracking**
  - All variants automatically traced
  - Filter by `experiment.variant` in Phoenix UI
  - Compare latency, cost, evaluation scores

3. **Statistical Analysis**
  - After 1000 queries per variant:
    - Export results via Phoenix API
    - Run statistical tests (t-test, chi-square)
    - Determine winner with 95% confidence
  - Update default model based on results

4. **Automated Model Selection**
  - Use cheaper model (Haiku) for simple queries
  - Detect query complexity with heuristics:
    - Presence of CTEs, subqueries, multiple JOINs
    - User asking for "complex analysis"
  - Route complex queries to Sonnet/Opus
  - Track accuracy of complexity classifier in Phoenix

**Technical Requirements:**
- Update `chat-query.ts` with model selection logic
- Span attributes for experiment tracking
- Analysis script: `scripts/analyze_model_experiment.py`
- Decision logic for model routing

**Value Delivered:**
- 40-60% cost reduction by using right-sized models
- Maintain quality on complex queries
- Data-driven model selection
- Automatic adaptation as models improve

---

### 4. ADVANCED TRACING

#### 4.1 Expand Tracing to Other Lambdas
**What This Enables:**
- Full observability across Songbird backend
- Trace user requests end-to-end (API → ingest → processing)
- Debug multi-Lambda workflows
- Identify bottlenecks across services

**How To Implement:**
1. **Trace Additional Lambdas**
  - `api-ingest`: Track Notehub event processing
  - `api-commands`: Trace command sending to devices
  - `api-devices`: Monitor device CRUD operations
  - `analytics/sync-to-aurora`: Track DynamoDB → Aurora sync performance

2. **Shared Tracing Utility**
  - Already exists: `lambda/shared/tracing.ts`
  - Import and call `initializeTracing(serviceName)` at top of each Lambda
  - Set `PHOENIX_COLLECTOR_ENDPOINT` env var via CDK

3. **Distributed Tracing**
  - Propagate trace context across Lambda invocations
  - Use OpenTelemetry context propagation
  - See end-to-end trace: API Gateway → Lambda → DynamoDB → Aurora

4. **Custom Spans**
  - Wrap key operations with `traceAsyncFn()`
  - Examples:
    - DynamoDB queries
    - Aurora Data API calls
    - External API calls (Notehub API)
    - Business logic (mode calculations, alert checks)

**Technical Requirements:**
- Update all Lambda CDK constructs to include Phoenix env vars
- Import tracing utility in each Lambda handler
- Add custom spans for key operations
- Test trace propagation across services

**Value Delivered:**
- Comprehensive system observability
- Faster debugging of production issues
- Performance optimization insights
- Understanding of system bottlenecks

---

#### 4.2 Session-Based Tracing
**What This Enables:**
- Group all queries in a user's analytics session
- Analyze conversation context
- Track session-level metrics (engagement, success rate)
- Understand user behavior patterns

**How To Implement:**
1. **Session ID Propagation**
  - Already present: `sessionId` in ChatRequest
  - Add as span attribute: `session.id`
  - Phoenix automatically groups traces by session

2. **Session Annotations**
  - Collect user feedback at session level
  - "Was this session helpful?" thumbs up/down
  - Store via Phoenix Annotation API
  - Link annotations to session ID

3. **Session Analytics**
  - Phoenix dashboard filtered by `session.id`
  - Metrics:
    - Queries per session (avg, p50, p95)
    - Session duration
    - Success rate (queries without errors)
    - User satisfaction (from annotations)

4. **Dashboard Integration**
  - Songbird analytics page shows "Recent Sessions"
  - Click to view full session trace in Phoenix
  - Inline user feedback collection

**Technical Requirements:**
- Add `session.id` span attribute in `chat-query.ts`
- Phoenix Annotation API for feedback
- Dashboard API integration to fetch session metrics
- UI for user feedback (thumbs up/down)

**Value Delivered:**
- Understand user analytics workflows
- Identify common question patterns
- Improve UX based on session analysis
- Measure user satisfaction quantitatively

---

### 5. COST TRACKING & OPTIMIZATION

#### 5.1 LLM Cost Dashboard
**What This Enables:**
- Track analytics feature costs over time
- Identify expensive queries
- Optimize prompts to reduce token usage
- Budget forecasting

**How To Implement:**
1. **Cost Calculation**
  - Phoenix automatically captures token usage from spans
  - Add cost calculation logic:
```typescript
     const inputCost = inputTokens * MODEL_PRICING[modelId].input / 1_000_000;
     const outputCost = outputTokens * MODEL_PRICING[modelId].output / 1_000_000;
     span.setAttribute('llm.cost.input', inputCost);
     span.setAttribute('llm.cost.output', outputCost);
     span.setAttribute('llm.cost.total', inputCost + outputCost);
```

2. **Phoenix Cost Dashboard**
  - Create custom dashboard in Phoenix UI
  - Widgets:
    - Total cost (daily, weekly, monthly)
    - Cost per query
    - Cost by model
    - Top 10 most expensive queries

3. **Cost Alerts**
  - Phoenix alert when daily cost exceeds threshold
  - Webhook to Slack/SNS
  - Investigate and optimize expensive operations

4. **Songbird Dashboard Integration**
  - New widget: "Analytics Cost"
  - Show current month spend
  - Trend graph (cost over time)
  - Link to Phoenix for detailed analysis

**Technical Requirements:**
- Model pricing constants in `chat-query.ts`
- Cost span attributes
- Phoenix custom dashboard configuration
- API integration to fetch cost data

**Value Delivered:**
- Visibility into AI feature costs
- Data-driven optimization decisions
- Budget management and forecasting
- Catch cost anomalies early

---

#### 5.2 Prompt Token Optimization
**What This Enables:**
- Reduce token usage without sacrificing quality
- Compress prompts intelligently
- Cache common prompt components
- Lower per-query costs

**How To Implement:**
1. **Analyze Token Usage**
  - Phoenix dashboard: token usage by prompt section
  - Identify largest sections:
    - Schema context (~1500 tokens)
    - Few-shot examples (~3000 tokens)
    - Task prompt (~500 tokens)

2. **Optimization Strategies**
  - **Schema Compression**: Remove verbose descriptions, abbreviate
  - **Dynamic Examples**: Select 2-3 most relevant examples vs. all 5
  - **Prompt Caching**: Use Claude's prompt caching for static parts
    - Cache schema context (changes rarely)
    - Fresh: user question and examples
  - **Shorter Instructions**: Test abbreviated task prompt

3. **A/B Test Optimizations**
  - Run experiment: original vs. compressed prompt
  - Measure: token usage, cost, quality (evaluation scores)
  - Deploy if cost reduced by ≥30% with <5% quality drop

4. **Dynamic Example Selection**
  - Use embedding similarity to select relevant examples
  - Index few-shot examples with embeddings
  - At query time: find 2 most similar examples
  - Reduces prompt size by ~40%

**Technical Requirements:**
- Prompt compression script
- Embedding similarity search (optional)
- Claude prompt caching configuration
- Experiment framework for testing

**Value Delivered:**
- 30-50% cost reduction per query
- Faster inference (fewer tokens to process)
- Maintained or improved quality
- Scalable AI feature cost structure

---

### 6. HUMAN FEEDBACK & ANNOTATIONS

#### 6.1 User Feedback Collection
**What This Enables:**
- Understand which queries users find helpful
- Identify problematic outputs
- Build human-labeled dataset for evaluation
- Improve LLM with RLHF-style feedback

**How To Implement:**
1. **Dashboard Feedback UI**
  - Add thumbs up/down to each analytics query result
  - Optional text feedback: "What went wrong?"
  - Stored with query in ChatHistory DynamoDB

2. **Push Feedback to Phoenix**
  - When user submits feedback:
    - Lookup span ID from session/timestamp
    - Call Phoenix Annotation API
    - Annotation type: categorical (positive/negative) + freeform (text)
    - Annotator: HUMAN

3. **Phoenix Annotation Interface**
  - Admins review all feedback in Phoenix UI
  - Filter traces by annotation: `annotation.label=negative`
  - Analyze failures, update prompts
  - Add to "failed-queries" dataset for testing

4. **Feedback Metrics**
  - Phoenix dashboard: User satisfaction rate
  - Track over time to measure improvements
  - Goal: ≥85% positive feedback

**Technical Requirements:**
- Dashboard UI: thumbs up/down component
- API endpoint: `POST /analytics/feedback`
- Lambda updates to call Phoenix Annotation API
- ChatHistory table: add `user_feedback` column

**Value Delivered:**
- Direct user feedback loop
- Identify blind spots in LLM performance
- Prioritize improvements based on user pain
- Build trust with responsive improvements

---

#### 6.2 Expert Query Annotation
**What This Enables:**
- Data engineers label query quality
- Create gold standard dataset
- Train query complexity classifier
- Validate evaluation rubrics

**How To Implement:**
1. **Annotation Workflow**
  - Weekly: export 50 recent queries to Phoenix
  - Data engineer reviews in Phoenix Annotation UI
  - Labels:
    - Query correctness (correct/incorrect)
    - Insight quality (1-5 scale)
    - Complexity (simple/medium/complex)
  - Keyboard shortcuts for rapid annotation

2. **Dataset Creation**
  - Annotated queries become "expert-labeled" dataset
  - Used for:
    - Validating LLM-as-judge evaluators
    - Fine-tuning models
    - Training complexity classifier

3. **Annotation Analytics**
  - Inter-annotator agreement metrics
  - Identify ambiguous cases
  - Refine annotation rubric

**Technical Requirements:**
- Phoenix Annotation UI access for data engineers
- Export script to create annotation tasks
- Dataset management for labeled data

**Value Delivered:**
- High-quality labeled data
- Validation of automated evaluations
- Expert insights into LLM behavior
- Foundation for supervised learning

---

### 7. RETRIEVAL & EMBEDDING ANALYSIS

#### 7.1 Query Embedding Drift Detection
**What This Enables:**
- Detect when user query patterns shift
- Identify new query types not in training data
- Alert when prompt/model may need updates
- Understand user behavior evolution

**How To Implement:**
1. **Capture Query Embeddings**
  - Generate embedding for each user question
  - Use Bedrock Titan Embeddings or Cohere
  - Store embedding in span attributes (Phoenix supports embedding arrays)
  - Tag with timestamp

2. **Phoenix Embedding Analysis**
  - Weekly: export query embeddings from Phoenix
  - UMAP visualization of embedding clusters
  - Compare clusters over time:
    - Identify emerging clusters (new query patterns)
    - Measure centroid drift (distribution shift)

3. **Drift Alerts**
  - Phoenix drift detection feature
  - Alert when embedding distribution shifts >20%
  - Investigate new query types, update prompts

4. **Cluster Analysis**
  - Label clusters with common themes
  - Examples:
    - "Device location queries"
    - "Temperature analysis"
    - "Journey tracking"
  - Track cluster performance (success rate per cluster)

**Technical Requirements:**
- Add embedding generation to `chat-query.ts`
- Embedding model: Bedrock Titan or Cohere
- Phoenix embedding analysis dashboard
- Drift detection configuration

**Value Delivered:**
- Proactive prompt adaptation
- Understanding of user needs evolution
- Early detection of model performance degradation
- Data-driven product development

---

#### 7.2 Few-Shot Example Optimization
**What This Enables:**
- Automatically select best examples for each query
- Reduce prompt size with dynamic selection
- Improve SQL generation quality
- Adapt to different query types

**How To Implement:**
1. **Example Embedding Index**
  - Create embeddings for all 5 few-shot examples
  - Store in in-memory index (Lambda cold start)
  - Use cosine similarity for retrieval

2. **Dynamic Example Selection**
```typescript
   // At query time
   const queryEmbedding = await generateEmbedding(userQuestion);
   const topExamples = findTopK(queryEmbedding, exampleEmbeddings, k=2);
   const prompt = buildPrompt(schema, topExamples, userQuestion);
```

3. **Measure Impact**
  - A/B test: all examples vs. 2 selected examples
  - Metrics: token usage (-40%), latency (-30%), quality (same or better)
  - Phoenix experiment tracking

4. **Example Performance Analysis**
  - Track which examples are selected most often
  - Measure success rate per example
  - Replace underperforming examples

**Technical Requirements:**
- Embedding generation for examples and queries
- Cosine similarity function
- Example index in Lambda global scope
- Experiment tracking

**Value Delivered:**
- 40% token cost reduction
- 30% latency improvement
- Maintained or improved quality
- Scalable to larger example libraries

---

### 8. ALERTS & MONITORING

#### 8.1 LLM Performance Alerts
**What This Enables:**
- Immediate notification of LLM failures
- Track latency degradation
- Monitor evaluation score drops
- Proactive issue resolution

**How To Implement:**
1. **Phoenix Alert Configuration**
  - Error Rate Alert:
    - Condition: SQL generation error rate >5%
    - Window: 1 hour
    - Action: Slack webhook to #eng-alerts
  - Latency Alert:
    - Condition: p95 latency >10s
    - Window: 1 hour
    - Action: SNS topic → PagerDuty
  - Evaluation Alert:
    - Condition: Hallucination rate >10%
    - Window: 1 day
    - Action: Slack webhook to #ai-quality

2. **Webhook Integration**
  - Create Slack incoming webhook
  - Configure in Phoenix alert settings
  - Test with mock alert

3. **Alert Dashboard**
  - Songbird admin page shows active alerts
  - Link to Phoenix for investigation
  - Acknowledge/resolve workflow

**Technical Requirements:**
- Phoenix alert configuration
- Slack webhook URL
- SNS topic for PagerDuty integration
- API integration to fetch alert status

**Value Delivered:**
- Proactive issue detection
- Reduced MTTR (mean time to resolution)
- Confidence in production AI features
- Better customer experience

---

#### 8.2 Daily Analytics Report
**What This Enables:**
- Morning briefing on analytics feature health
- Trends and usage statistics
- Automated reporting without manual queries

**How To Implement:**
1. **Scheduled Lambda**
  - Lambda: `songbird-analytics-daily-report`
  - Triggered daily at 8am UTC (EventBridge)
  - Queries Phoenix API for yesterday's data

2. **Report Content**
  - Total queries
  - Error rate
  - Average latency (p50, p95)
  - Token usage and cost
  - Top 10 queries (by frequency)
  - Evaluation score summary
  - User feedback summary

3. **Delivery**
  - Email via SES to eng team
  - Slack message to #analytics-monitoring
  - Store in S3 for historical analysis

4. **Report Dashboard**
  - Songbird admin page: "Analytics Reports"
  - View historical reports
  - Download as PDF or CSV

**Technical Requirements:**
- New Lambda: `lambda/analytics/daily-report.ts`
- EventBridge rule (cron: 0 8 * * ? *)
- Phoenix API integration
- SES email template
- Slack webhook integration

**Value Delivered:**
- Automated monitoring without manual effort
- Trends visible at a glance
- Historical tracking for retrospectives
- Data-driven feature development

---

### 9. DASHBOARD INTEGRATIONS

#### 9.1 Embedded Phoenix UI
**What This Enables:**
- Access Phoenix traces from Songbird dashboard
- Seamless debugging experience
- No need to switch between tools

**How To Implement:**
1. **Deep Linking**
  - Each analytics query result includes "View Trace" button
  - Link format: `https://phoenix.songbird.live/traces/{traceId}`
  - Opens Phoenix UI filtered to that trace

2. **Iframe Embedding** (optional)
  - Embed Phoenix UI in modal within Songbird
  - Requires Phoenix CORS configuration
  - Authentication: pass JWT token to Phoenix

3. **Trace Context in Songbird**
  - Store trace ID in ChatHistory DynamoDB
  - API endpoint: `GET /analytics/sessions/{sessionId}/trace`
  - Returns trace ID for deep linking

**Technical Requirements:**
- Update `chat-query.ts` to return trace ID
- ChatHistory table: add `trace_id` column
- Dashboard UI: "View Trace" button
- Phoenix CORS config (if embedding)

**Value Delivered:**
- Unified debugging experience
- Faster issue investigation
- Lower friction to trace adoption

---

#### 9.2 Analytics Quality Metrics Widget
**What This Enables:**
- Songbird dashboard shows analytics health at a glance
- Visibility into AI feature quality
- Transparency for sales demos

**How To Implement:**
1. **Widget Design**
  - Card in Analytics page header
  - Metrics:
    - Success Rate: 94% (last 7 days)
    - Avg Latency: 2.3s
    - User Satisfaction: 87% positive
    - Queries Today: 142

2. **API Integration**
  - Lambda: `songbird-analytics-metrics`
  - Fetches from Phoenix API and DynamoDB
  - Caches for 5 minutes (CloudFront or Lambda)

3. **Real-Time Updates**
  - WebSocket or polling (every 30s)
  - Show trend arrows (↑ improving, ↓ degrading)

**Technical Requirements:**
- New Lambda: `lambda/analytics/metrics.ts`
- Phoenix API integration
- Dashboard component: `AnalyticsMetrics.tsx`
- API route: `GET /analytics/metrics`

**Value Delivered:**
- Visibility into AI feature health
- Sales demo talking point ("94% success rate")
- Internal quality tracking
- User confidence in AI features

---

### 10. ADVANCED FEATURES

#### 10.1 Multi-Project Setup
**What This Enables:**
- Separate dev/staging/prod traces
- Team-based access control
- Isolated testing environments

**How To Implement:**
1. **Phoenix Projects**
  - Create projects via Phoenix API:
    - `songbird-analytics-dev`
    - `songbird-analytics-staging`
    - `songbird-analytics-prod`

2. **Environment-Based Routing**
  - Lambda environment variable: `PHOENIX_PROJECT_ID`
  - Set in CDK based on stack environment
  - Traces automatically scoped to project

3. **RBAC Configuration**
  - Admin: full access to all projects
  - Engineers: dev + staging (read/write), prod (read-only)
  - Sales: prod (read-only) for customer demos

**Technical Requirements:**
- Phoenix projects API
- Environment-based configuration in CDK
- RBAC setup in Phoenix (requires Phoenix 5.0+)

**Value Delivered:**
- Clean separation of environments
- Safe testing without prod impact
- Team collaboration on staging
- Production data protection

---

#### 10.2 Guardrails Integration
**What This Enables:**
- Prevent malicious SQL injection attempts
- Block PII in query responses
- Enforce query complexity limits
- Content safety checks

**How To Implement:**
1. **Guardrails AI Integration**
  - Install: `npm install guardrails-ai`
  - Guards:
    - SQL Injection Guard (regex + LLM)
    - PII Detection Guard (detect SSN, credit cards)
    - Query Complexity Guard (max 5 JOINs, no nested subqueries >3 levels)

2. **Pre-Execution Validation**
```typescript
   const guardResult = await validateSQL(generatedSQL);
   if (!guardResult.success) {
     span.setAttribute('guardrail.blocked', true);
     span.setAttribute('guardrail.reason', guardResult.reason);
     return error("Query blocked by safety guardrails");
   }
```

3. **Phoenix Guardrail Tracing**
  - Guardrails automatically traced (Phoenix 4.11+)
  - Create dataset from blocked queries
  - Analyze patterns, tune guards

**Technical Requirements:**
- Guardrails AI library
- Guard definitions in `chat-query.ts`
- Phoenix guardrail tracing enabled

**Value Delivered:**
- Production safety
- PII protection
- Attack prevention
- Compliance (data governance)

---

#### 10.3 Automated Prompt Optimization
**What This Enables:**
- LLM suggests prompt improvements
- Automatic A/B testing of suggestions
- Continuous prompt evolution
- Reduced manual prompt engineering effort

**How To Implement:**
1. **Meta-Prompting Workflow**
  - Weekly: Phoenix analyzes failed traces
  - LLM generates prompt improvement suggestions
  - Presents to engineer via UI

2. **Automated Testing**
  - Engineer reviews suggestion
  - Clicks "Test on Dataset"
  - Phoenix runs experiment automatically
  - Shows evaluation comparison

3. **Deployment Pipeline**
  - If improvement >5% with p<0.05:
    - Commit new prompt to Prompt Hub
    - Update Lambda env var: `PHOENIX_PROMPT_VERSION=v3.1`
    - Deploy via CDK
  - If no improvement: archive suggestion

**Technical Requirements:**
- Phoenix meta-prompting feature
- Experiment automation
- Prompt versioning in Prompt Hub
- Lambda configuration management

**Value Delivered:**
- Continuous improvement without manual effort
- Data-driven prompt evolution
- Faster iteration cycles
- Scalable prompt optimization

---

## Implementation Priorities

### Phase 1: Foundation (Weeks 1-2)
**Goal**: Expand tracing and establish evaluation baseline

1. **Expand Tracing** (Priority: HIGH)
  - Enable tracing in 5 additional Lambdas
  - Add custom spans for key operations
  - Test distributed tracing across services

2. **Create Golden Dataset** (Priority: HIGH)
  - Curate 50 high-quality queries from production
  - Store in Phoenix
  - Manual validation by data engineer

3. **Basic Evaluations** (Priority: HIGH)
  - Implement SQL syntax validator
  - Deploy daily evaluation Lambda
  - Set up Phoenix cost tracking

**Deliverables**:
- All analytics Lambdas sending traces to Phoenix
- Golden dataset with 50 examples
- Daily evaluation reports

---

### Phase 2: Evaluation & Optimization (Weeks 3-4)
**Goal**: Automated quality assessment and cost optimization

1. **Evaluation Framework** (Priority: HIGH)
  - LLM-as-judge evaluators (hallucination, relevance)
  - Run evaluations on golden dataset
  - Dashboard integration (quality metrics widget)

2. **Cost Optimization** (Priority: MEDIUM)
  - Implement cost tracking with model pricing
  - Phoenix cost dashboard
  - Prompt token optimization (compress examples)
  - A/B test optimizations

3. **Human Feedback** (Priority: MEDIUM)
  - Add thumbs up/down to dashboard
  - Push feedback to Phoenix annotations
  - Weekly feedback review workflow

**Deliverables**:
- Automated evaluation pipeline
- Cost tracking dashboard
- 30% token reduction
- User feedback collection

---

### Phase 3: Experimentation & Iteration (Weeks 5-6)
**Goal**: Enable rapid prompt/model iteration

1. **Experiment Framework** (Priority: HIGH)
  - CI/CD evaluation on PRs
  - Prompt versioning in Prompt Hub
  - A/B test infrastructure (model comparison)

2. **Prompt Playground** (Priority: MEDIUM)
  - Refactor prompts as templates
  - Phoenix Prompt Hub integration
  - Span replay for debugging

3. **Embedding Analysis** (Priority: LOW)
  - Generate query embeddings
  - Phoenix embedding visualization
  - Drift detection

**Deliverables**:
- GitHub Action for prompt evaluation
- Prompt templates in Phoenix
- Multi-model A/B test results

---

### Phase 4: Advanced Features (Weeks 7-8)
**Goal**: Production hardening and monitoring

1. **Alerts & Monitoring** (Priority: HIGH)
  - Phoenix alerts (error rate, latency)
  - Slack/PagerDuty integration
  - Daily analytics report

2. **Guardrails** (Priority: MEDIUM)
  - SQL injection guard
  - PII detection guard
  - Complexity limits

3. **Dashboard Integration** (Priority: LOW)
  - Embedded Phoenix traces
  - Real-time quality metrics widget
  - Session-based tracing

**Deliverables**:
- Production monitoring and alerting
- Safety guardrails deployed
- Unified observability experience

---

## Resource Requirements

### Infrastructure
- **Phoenix Server**: Already deployed (ECS Fargate)
- **Additional Lambda Functions**: 3 new Lambdas (~512MB each)
- **Storage**: Phoenix EFS will grow (estimate +10GB over 6 months)
- **Network**: Additional OTLP traffic (~1-5 GB/month)

**Cost Estimate**: +$50-100/month

### Development Time
- **Phase 1**: 2 weeks (1 engineer)
- **Phase 2**: 2 weeks (1 engineer)
- **Phase 3**: 2 weeks (1 engineer)
- **Phase 4**: 2 weeks (1 engineer)

**Total**: 8 weeks of dedicated engineering effort

### Dependencies
- Phoenix 8.0+ (already deployed)
- AWS Bedrock access (already configured)
- GitHub Actions (available)
- Slack webhook (need to create)

---

## Success Metrics

### Quantitative
1. **Evaluation Coverage**: 100% of analytics queries evaluated within 24h
2. **Success Rate**: ≥94% SQL queries execute without errors
3. **User Satisfaction**: ≥85% positive feedback
4. **Cost Reduction**: 30% lower token usage via optimization
5. **Latency**: p95 latency <5s
6. **Tracing Coverage**: All backend Lambdas instrumented

### Qualitative
1. **Developer Experience**: Engineers can debug analytics issues in <10 minutes
2. **Confidence**: Team comfortable deploying prompt changes
3. **Transparency**: Sales can demo analytics quality metrics
4. **Insights**: Weekly learnings from Phoenix analysis drive improvements

---

## Risks & Mitigations

### Risk 1: Phoenix Performance Impact
**Risk**: High tracing volume could degrade Phoenix server performance
**Mitigation**:
- Monitor Phoenix ECS metrics (CPU, memory)
- Scale to 2 Fargate tasks if needed
- Use sampling (trace 10% of queries) in production

### Risk 2: Evaluation Accuracy
**Risk**: LLM-as-judge evaluators may not align with human judgment
**Mitigation**:
- Validate evaluators against human-labeled dataset
- Track inter-annotator agreement
- Use ensemble of evaluators (code + LLM)

### Risk 3: Integration Complexity
**Risk**: Phoenix API integration adds complexity to Lambdas
**Mitigation**:
- Use shared utility library (`lambda/shared/phoenix-utils.ts`)
- Comprehensive error handling (Phoenix unavailable = graceful degradation)
- Unit tests for Phoenix integrations

### Risk 4: Cost Overruns
**Risk**: Evaluation and embedding generation could increase costs
**Mitigation**:
- Use cheaper models for evaluations (Haiku vs Sonnet)
- Batch evaluation (100 queries at a time)
- Cache embeddings to avoid regeneration
- Set budget alerts in AWS Cost Explorer

---

## Alternative Approaches Considered

### Alternative 1: Build Custom Evaluation System
**Why Not**: Phoenix provides battle-tested evaluation framework, saving 4-6 weeks of development. Custom system would lack UI, experiments, and dataset management.

### Alternative 2: Use LangSmith or LangFuse
**Why Phoenix**: Already integrated, Phoenix has superior embedding analysis and prompt playground. Migration would require infrastructure changes and learning curve.

### Alternative 3: Manual Evaluation Only
**Why Not**: Doesn't scale beyond toy projects. Phoenix automation enables continuous quality improvement without constant human review.

---

## Next Steps

1. **Review & Approval**: Team reviews this plan, prioritizes phases
2. **Spike**: 2-day spike on evaluation framework and dataset creation
3. **Kickoff**: Start Phase 1 implementation
4. **Iteration**: Weekly demos of new Phoenix features
5. **Documentation**: Update CLAUDE.md with Phoenix integration patterns

---

## References

- [Arize Phoenix Documentation](https://arize.com/docs/phoenix)
- [OpenInference Specification](https://arize-ai.github.io/openinference/)
- [Phoenix Python SDK](https://arize-phoenix.readthedocs.io/)
- [Phoenix REST API](https://arize.com/docs/phoenix/sdk-api-reference/rest-api/overview)
- Current Songbird Phoenix Integration:
  - `songbird-infrastructure/lib/observability-construct.ts`
  - `songbird-infrastructure/lambda/shared/tracing.ts`
  - `songbird-infrastructure/lambda/analytics/chat-query.ts`
