---
planStatus:
  planId: plan-admin-confirm-users
  title: Admin Confirm Unconfirmed Users from Dashboard
  status: completed
  planType: feature
  priority: medium
  owner: developer
  tags:
    - dashboard
    - admin
    - cognito
    - user-management
  created: "2026-02-03"
  updated: "2026-02-03T12:30:00.000Z"
  progress: 100
---
# Admin Confirm Unconfirmed Users from Dashboard

## Goals
- Allow Admin users to confirm unconfirmed Cognito users directly from the dashboard
- Provide visibility into which users are pending confirmation
- Streamline user onboarding workflow without requiring AWS Console access

## Overview

Currently, when new users are created in the Songbird dashboard, they may remain in an "unconfirmed" state in Cognito (e.g., if email verification is pending or if they were created programmatically). Admins currently need to access the AWS Console to manually confirm these users.

This feature adds a UI control in the User Management section allowing Admins to see unconfirmed users and confirm them with a single click.

## Implementation Details

### Backend Changes

**Lambda: `songbird-infrastructure/lambda/users/`**

1. Add `confirmUser` handler that calls Cognito `AdminConfirmSignUp` API
2. Ensure the API returns user confirmation status in `listUsers` response
3. Add appropriate IAM permissions for Lambda to call `AdminConfirmSignUp`

### Frontend Changes

**Dashboard: `songbird-dashboard/src/`**

1. Update User type to include confirmation status
2. Add "Confirm" button in user table for unconfirmed users
3. Show confirmation status badge (Confirmed/Unconfirmed)
4. Add confirmation action to user management API hooks

### API Endpoint

```
POST /users/{userId}/confirm
```

**Authorization**: Admin group only

## Acceptance Criteria

- [x] Admin can see which users are unconfirmed in the Users table
- [x] Admin can click "Confirm" button to confirm an unconfirmed user
- [x] Confirmation status updates immediately in the UI after action
- [x] Non-admin users cannot see or use the confirm functionality
- [x] Appropriate error handling for failed confirmations
- [ ] Success toast notification after confirming a user (optional enhancement)

## Notes

- Uses Cognito `AdminConfirmSignUp` API
- Only visible to Admin group members
- Consider adding bulk confirm functionality in future iteration
