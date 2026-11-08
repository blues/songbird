#!/usr/bin/env node
/**
 * Songbird Infrastructure CDK App
 *
 * Entry point for AWS CDK deployment of Songbird cloud infrastructure.
 */

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SongbirdStack } from '../lib/songbird-stack';

const app = new cdk.App();

// Get configuration from context or environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
};

// Notehub configuration
const notehubProjectUid = app.node.tryGetContext('notehubProjectUid') || 'com.blues.songbird';

// CORS allowed origins (comma-separated context override, else default in stack)
const corsContext = app.node.tryGetContext('corsAllowedOrigins');
const corsAllowedOrigins = corsContext
  ? String(corsContext).split(',').map((o) => o.trim()).filter(Boolean)
  : undefined;

new SongbirdStack(app, 'SongbirdStack', {
  env,
  description: 'Songbird Demo Platform - AWS Infrastructure',
  notehubProjectUid,
  corsAllowedOrigins,

  // Tag all resources
  tags: {
    Project: 'Songbird',
    Environment: 'production',
    ManagedBy: 'CDK',
  },
});

app.synth();
