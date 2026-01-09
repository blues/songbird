/**
 * Cognito Post-Confirmation Trigger
 *
 * Automatically adds newly self-registered users to the Viewer group.
 * This ensures all self-registered users have read-only access by default.
 */
import type { PostConfirmationTriggerEvent, Context, Callback } from 'aws-lambda';
export declare const handler: (event: PostConfirmationTriggerEvent, _context: Context, callback: Callback) => Promise<PostConfirmationTriggerEvent>;
