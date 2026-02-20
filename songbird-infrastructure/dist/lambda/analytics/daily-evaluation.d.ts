/**
 * Daily Evaluation Lambda
 *
 * Runs automated evaluations on the last 24 hours of analytics chat queries.
 * Generates a quality report and optionally sends it via SNS.
 */
import { ScheduledEvent } from 'aws-lambda';
export declare const handler: (_event: ScheduledEvent) => Promise<void>;
