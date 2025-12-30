/**
 * Cognito Post-Confirmation Trigger
 *
 * Automatically adds newly self-registered users to the Viewer group.
 * This ensures all self-registered users have read-only access by default.
 */

import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent, Context, Callback } from 'aws-lambda';

const cognitoClient = new CognitoIdentityProviderClient({});

const DEFAULT_GROUP = 'Viewer';

export const handler = async (
  event: PostConfirmationTriggerEvent,
  _context: Context,
  callback: Callback
): Promise<PostConfirmationTriggerEvent> => {
  console.log('Post-confirmation trigger:', JSON.stringify(event, null, 2));

  // Only process ConfirmSignUp trigger (not ConfirmForgotPassword)
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    console.log(`Skipping trigger source: ${event.triggerSource}`);
    return event;
  }

  const userPoolId = event.userPoolId;
  const username = event.userName;

  try {
    // Add user to the default Viewer group
    const command = new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: username,
      GroupName: DEFAULT_GROUP,
    });

    await cognitoClient.send(command);
    console.log(`Added user ${username} to group ${DEFAULT_GROUP}`);

  } catch (error) {
    console.error(`Failed to add user ${username} to group ${DEFAULT_GROUP}:`, error);
    // Don't fail the sign-up process even if group assignment fails
    // The user can still access the app, just without group permissions initially
  }

  // Return the event to continue the sign-up process
  return event;
};
