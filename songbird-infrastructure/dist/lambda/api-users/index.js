"use strict";
/**
 * API Users Lambda
 *
 * Handles user management operations using Cognito Admin APIs.
 * All endpoints are admin-only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_cognito_identity_provider_1 = require("@aws-sdk/client-cognito-identity-provider");
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const lib_dynamodb_1 = require("@aws-sdk/lib-dynamodb");
const cognitoClient = new client_cognito_identity_provider_1.CognitoIdentityProviderClient({});
const dynamoClient = new client_dynamodb_1.DynamoDBClient({});
const docClient = lib_dynamodb_1.DynamoDBDocumentClient.from(dynamoClient);
const USER_POOL_ID = process.env.USER_POOL_ID || '';
const DEVICES_TABLE = process.env.DEVICES_TABLE || 'songbird-devices';
const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const VALID_GROUPS = ['Admin', 'Sales', 'FieldEngineering', 'Viewer'];
function isAdmin(event) {
    try {
        const claims = event.requestContext?.authorizer?.jwt?.claims;
        if (!claims)
            return false;
        const groups = claims['cognito:groups'];
        if (Array.isArray(groups)) {
            return groups.includes('Admin');
        }
        if (typeof groups === 'string') {
            return groups === 'Admin' || groups.includes('Admin');
        }
        return false;
    }
    catch {
        return false;
    }
}
async function listUsers() {
    const result = await cognitoClient.send(new client_cognito_identity_provider_1.ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Limit: 60,
    }));
    const users = [];
    for (const user of result.Users || []) {
        const emailAttr = user.Attributes?.find((a) => a.Name === 'email');
        const nameAttr = user.Attributes?.find((a) => a.Name === 'name');
        // Get groups for this user
        const groupsResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminListGroupsForUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: user.Username,
        }));
        const groups = (groupsResult.Groups || []).map((g) => g.GroupName);
        users.push({
            username: user.Username,
            email: emailAttr?.Value || '',
            name: nameAttr?.Value || '',
            status: user.UserStatus || 'UNKNOWN',
            created_at: user.UserCreateDate?.toISOString() || '',
            groups,
        });
    }
    return users;
}
async function getDevicesAssignedToUser(userEmail) {
    const result = await docClient.send(new lib_dynamodb_1.ScanCommand({
        TableName: DEVICES_TABLE,
        FilterExpression: 'assigned_to = :email',
        ExpressionAttributeValues: {
            ':email': userEmail,
        },
        ProjectionExpression: 'device_uid',
    }));
    return (result.Items || []).map((item) => item.device_uid);
}
async function assignDeviceToUser(deviceUid, userEmail, userName) {
    // First, unassign any device currently assigned to this user (single device per user)
    const currentDevices = await getDevicesAssignedToUser(userEmail);
    if (currentDevices.length > 0) {
        await unassignDevicesFromUser(currentDevices);
    }
    // Now assign the new device with both email and name
    const updateExpression = userName
        ? 'SET assigned_to = :email, assigned_to_name = :name, updated_at = :now'
        : 'SET assigned_to = :email, updated_at = :now';
    const expressionValues = {
        ':email': userEmail,
        ':now': Date.now(),
    };
    if (userName) {
        expressionValues[':name'] = userName;
    }
    await docClient.send(new lib_dynamodb_1.UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: deviceUid },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionValues,
    }));
}
async function getUnassignedDevices() {
    const result = await docClient.send(new lib_dynamodb_1.ScanCommand({
        TableName: DEVICES_TABLE,
        FilterExpression: 'attribute_not_exists(assigned_to) OR assigned_to = :empty',
        ExpressionAttributeValues: {
            ':empty': '',
        },
        ProjectionExpression: 'device_uid, serial_number, #n',
        ExpressionAttributeNames: {
            '#n': 'name',
        },
    }));
    return (result.Items || []).map((item) => ({
        device_uid: item.device_uid,
        serial_number: item.serial_number,
        name: item.name,
    }));
}
async function unassignDevicesFromUser(deviceUids) {
    for (const deviceUid of deviceUids) {
        await docClient.send(new lib_dynamodb_1.UpdateCommand({
            TableName: DEVICES_TABLE,
            Key: { device_uid: deviceUid },
            UpdateExpression: 'REMOVE assigned_to, assigned_to_name SET updated_at = :now',
            ExpressionAttributeValues: {
                ':now': Date.now(),
            },
        }));
    }
}
async function handler(event) {
    console.log('Event:', JSON.stringify(event, null, 2));
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    // Handle OPTIONS for CORS
    if (method === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    // All user management endpoints require admin
    if (!isAdmin(event)) {
        return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Admin access required' }),
        };
    }
    try {
        // GET /v1/users - List all users
        if (method === 'GET' && path === '/v1/users') {
            const users = await listUsers();
            // Optionally include assigned devices for each user
            const includeDevices = event.queryStringParameters?.include_devices === 'true';
            if (includeDevices) {
                for (const user of users) {
                    user.assigned_devices = await getDevicesAssignedToUser(user.email);
                }
            }
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ users }),
            };
        }
        // GET /v1/users/groups - List available groups
        if (method === 'GET' && path === '/v1/users/groups') {
            const result = await cognitoClient.send(new client_cognito_identity_provider_1.ListGroupsCommand({
                UserPoolId: USER_POOL_ID,
            }));
            const groups = (result.Groups || []).map((g) => ({
                name: g.GroupName,
                description: g.Description,
            }));
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ groups }),
            };
        }
        // GET /v1/users/{userId} - Get specific user
        if (method === 'GET' && path.match(/^\/v1\/users\/[^/]+$/)) {
            const userId = event.pathParameters?.userId;
            if (!userId) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'User ID required' }),
                };
            }
            const userResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            const groupsResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminListGroupsForUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            const emailAttr = userResult.UserAttributes?.find((a) => a.Name === 'email');
            const nameAttr = userResult.UserAttributes?.find((a) => a.Name === 'name');
            const groups = (groupsResult.Groups || []).map((g) => g.GroupName);
            const assignedDevices = await getDevicesAssignedToUser(emailAttr?.Value || '');
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    username: userResult.Username,
                    email: emailAttr?.Value || '',
                    name: nameAttr?.Value || '',
                    status: userResult.UserStatus,
                    created_at: userResult.UserCreateDate?.toISOString(),
                    groups,
                    assigned_devices: assignedDevices,
                }),
            };
        }
        // POST /v1/users - Invite new user
        if (method === 'POST' && path === '/v1/users') {
            let body;
            try {
                body = JSON.parse(event.body || '{}');
            }
            catch {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Invalid JSON body' }),
                };
            }
            // Validate required fields
            if (!body.email || !body.name || !body.group) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'email, name, and group are required' }),
                };
            }
            // Validate group
            if (!VALID_GROUPS.includes(body.group)) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: `group must be one of: ${VALID_GROUPS.join(', ')}` }),
                };
            }
            // Create user in Cognito
            const createResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminCreateUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: body.email,
                UserAttributes: [
                    { Name: 'email', Value: body.email },
                    { Name: 'email_verified', Value: 'true' },
                    { Name: 'name', Value: body.name },
                ],
                DesiredDeliveryMediums: ['EMAIL'],
            }));
            // Add user to group
            await cognitoClient.send(new client_cognito_identity_provider_1.AdminAddUserToGroupCommand({
                UserPoolId: USER_POOL_ID,
                Username: body.email,
                GroupName: body.group,
            }));
            // Assign device if provided (only one device per user)
            if (body.device_uids && body.device_uids.length > 0) {
                // Only assign the first device (single device per user)
                await assignDeviceToUser(body.device_uids[0], body.email, body.name);
            }
            return {
                statusCode: 201,
                headers,
                body: JSON.stringify({
                    username: createResult.User?.Username,
                    email: body.email,
                    name: body.name,
                    groups: [body.group],
                    assigned_devices: body.device_uids || [],
                    status: createResult.User?.UserStatus,
                }),
            };
        }
        // PUT /v1/users/{userId}/groups - Update user groups
        if (method === 'PUT' && path.match(/^\/v1\/users\/[^/]+\/groups$/)) {
            const userId = event.pathParameters?.userId;
            if (!userId) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'User ID required' }),
                };
            }
            let body;
            try {
                body = JSON.parse(event.body || '{}');
            }
            catch {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Invalid JSON body' }),
                };
            }
            if (!body.groups || !Array.isArray(body.groups)) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'groups array required' }),
                };
            }
            // Validate all groups
            for (const group of body.groups) {
                if (!VALID_GROUPS.includes(group)) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ error: `Invalid group: ${group}. Must be one of: ${VALID_GROUPS.join(', ')}` }),
                    };
                }
            }
            // Get current groups
            const currentGroupsResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminListGroupsForUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            const currentGroups = (currentGroupsResult.Groups || []).map((g) => g.GroupName);
            // Remove from groups no longer in list
            for (const group of currentGroups) {
                if (!body.groups.includes(group)) {
                    await cognitoClient.send(new client_cognito_identity_provider_1.AdminRemoveUserFromGroupCommand({
                        UserPoolId: USER_POOL_ID,
                        Username: userId,
                        GroupName: group,
                    }));
                }
            }
            // Add to new groups
            for (const group of body.groups) {
                if (!currentGroups.includes(group)) {
                    await cognitoClient.send(new client_cognito_identity_provider_1.AdminAddUserToGroupCommand({
                        UserPoolId: USER_POOL_ID,
                        Username: userId,
                        GroupName: group,
                    }));
                }
            }
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    username: userId,
                    groups: body.groups,
                }),
            };
        }
        // PUT /v1/users/{userId}/device - Update user's assigned device (single device per user)
        if (method === 'PUT' && path.match(/^\/v1\/users\/[^/]+\/device$/)) {
            const userId = event.pathParameters?.userId;
            if (!userId) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'User ID required' }),
                };
            }
            let body;
            try {
                body = JSON.parse(event.body || '{}');
            }
            catch {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'Invalid JSON body' }),
                };
            }
            // Get user's email and name
            const userResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            const emailAttr = userResult.UserAttributes?.find((a) => a.Name === 'email');
            const nameAttr = userResult.UserAttributes?.find((a) => a.Name === 'name');
            const userEmail = emailAttr?.Value || '';
            const userName = nameAttr?.Value;
            if (!userEmail) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'User email not found' }),
                };
            }
            // Get currently assigned device
            const currentDevices = await getDevicesAssignedToUser(userEmail);
            // Unassign current device if any
            if (currentDevices.length > 0) {
                await unassignDevicesFromUser(currentDevices);
            }
            // Assign new device if provided
            if (body.device_uid) {
                await assignDeviceToUser(body.device_uid, userEmail, userName);
            }
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    username: userId,
                    email: userEmail,
                    assigned_device: body.device_uid || null,
                }),
            };
        }
        // GET /v1/devices/unassigned - Get devices not assigned to any user
        if (method === 'GET' && path === '/v1/devices/unassigned') {
            const devices = await getUnassignedDevices();
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ devices }),
            };
        }
        // POST /v1/users/{userId}/confirm - Confirm an unconfirmed user
        if (method === 'POST' && path.match(/^\/v1\/users\/[^/]+\/confirm$/)) {
            const userId = event.pathParameters?.userId;
            if (!userId) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'User ID required' }),
                };
            }
            // Confirm the user in Cognito
            await cognitoClient.send(new client_cognito_identity_provider_1.AdminConfirmSignUpCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    message: 'User confirmed successfully',
                    username: userId,
                }),
            };
        }
        // DELETE /v1/users/{userId} - Delete a user
        if (method === 'DELETE' && path.match(/^\/v1\/users\/[^/]+$/)) {
            const userId = event.pathParameters?.userId;
            if (!userId) {
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: 'User ID required' }),
                };
            }
            // Get user's email to unassign devices
            const userResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            const emailAttr = userResult.UserAttributes?.find((a) => a.Name === 'email');
            const userEmail = emailAttr?.Value || '';
            // Unassign any devices assigned to this user
            if (userEmail) {
                const assignedDevices = await getDevicesAssignedToUser(userEmail);
                if (assignedDevices.length > 0) {
                    await unassignDevicesFromUser(assignedDevices);
                }
            }
            // Delete the user from Cognito
            await cognitoClient.send(new client_cognito_identity_provider_1.AdminDeleteUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    message: 'User deleted successfully',
                    username: userId,
                }),
            };
        }
        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Not found' }),
        };
    }
    catch (error) {
        console.error('Error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Internal server error';
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
}
exports.handler = handler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLXVzZXJzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7O0FBRUgsZ0dBY21EO0FBQ25ELDhEQUEwRDtBQUMxRCx3REFBMkY7QUFHM0YsTUFBTSxhQUFhLEdBQUcsSUFBSSxnRUFBNkIsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUM1RCxNQUFNLFlBQVksR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDNUMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBRTVELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztBQUNwRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsSUFBSSxrQkFBa0IsQ0FBQztBQUV0RSxNQUFNLE9BQU8sR0FBRztJQUNkLGNBQWMsRUFBRSxrQkFBa0I7SUFDbEMsNkJBQTZCLEVBQUUsR0FBRztJQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7SUFDNUQsOEJBQThCLEVBQUUsNkJBQTZCO0NBQzlELENBQUM7QUFFRixNQUFNLFlBQVksR0FBRyxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFFdEUsU0FBUyxPQUFPLENBQUMsS0FBOEM7SUFDN0QsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE1BQU0sQ0FBQztRQUM3RCxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBRTFCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3hDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENB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LENBQUM7YUFDSCxDQUFDO1FBQ0osQ0FBQztRQUVELE9BQU87WUFDTCxVQUFVLEVBQUUsR0FBRztZQUNmLE9BQU87WUFDUCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLEtBQUssRUFBRSxXQUFXLEVBQUUsQ0FBQztTQUM3QyxDQUFDO0lBQ0osQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixPQUFPLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUMvQixNQUFNLFlBQVksR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQztRQUN0RixPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsWUFBWSxFQUFFLENBQUM7U0FDOUMsQ0FBQztJQUNKLENBQUM7QUFDSCxDQUFDO0FBL1pELDBCQStaQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQVBJIFVzZXJzIExhbWJkYVxuICpcbiAqIEhhbmRsZXMgdXNlciBtYW5hZ2VtZW50IG9wZXJhdGlvbnMgdXNpbmcgQ29nbml0byBBZG1pbiBBUElzLlxuICogQWxsIGVuZHBvaW50cyBhcmUgYWRtaW4tb25seS5cbiAqL1xuXG5pbXBvcnQge1xuICBDb2duaXRvSWRlbnRpdHlQcm92aWRlckNsaWVudCxcbiAgTGlzdFVzZXJzQ29tbWFuZCxcbiAgQWRtaW5DcmVhdGVVc2VyQ29tbWFuZCxcbiAgQWRtaW5BZGRVc2VyVG9Hcm91cENvbW1hbmQsXG4gIEFkbWluUmVtb3ZlVXNlckZyb21Hcm91cENvbW1hbmQsXG4gIEFkbWluTGlzdEdyb3Vwc0ZvclVzZXJDb21tYW5kLFxuICBBZG1pbkdldFVzZXJDb21tYW5kLFxuICBBZG1pblVwZGF0ZVVzZXJBdHRyaWJ1dGVzQ29tbWFuZCxcbiAgQWRtaW5EZWxldGVVc2VyQ29tbWFuZCxcbiAgQWRtaW5Db25maXJtU2lnblVwQ29tbWFuZCxcbiAgTGlzdEdyb3Vwc0NvbW1hbmQsXG4gIHR5cGUgQXR0cmlidXRlVHlwZSxcbiAgdHlwZSBHcm91cFR5cGUsXG59IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jb2duaXRvLWlkZW50aXR5LXByb3ZpZGVyJztcbmltcG9ydCB7IER5bmFtb0RCQ2xpZW50IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWR5bmFtb2RiJztcbmltcG9ydCB7IER5bmFtb0RCRG9jdW1lbnRDbGllbnQsIFVwZGF0ZUNvbW1hbmQsIFNjYW5Db21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvbGliLWR5bmFtb2RiJztcbmltcG9ydCB0eXBlIHsgQVBJR2F0ZXdheVByb3h5RXZlbnRWMldpdGhKV1RBdXRob3JpemVyLCBBUElHYXRld2F5UHJveHlSZXN1bHRWMiB9IGZyb20gJ2F3cy1sYW1iZGEnO1xuXG5jb25zdCBjb2duaXRvQ2xpZW50ID0gbmV3IENvZ25pdG9JZGVudGl0eVByb3ZpZGVyQ2xpZW50KHt9KTtcbmNvbnN0IGR5bmFtb0NsaWVudCA9IG5ldyBEeW5hbW9EQkNsaWVudCh7fSk7XG5jb25zdCBkb2NDbGllbnQgPSBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LmZyb20oZHluYW1vQ2xpZW50KTtcblxuY29uc3QgVVNFUl9QT09MX0lEID0gcHJvY2Vzcy5lbnYuVVNFUl9QT09MX0lEIHx8ICcnO1xuY29uc3QgREVWSUNFU19UQUJMRSA9IHByb2Nlc3MuZW52LkRFVklDRVNfVEFCTEUgfHwgJ3NvbmdiaXJkLWRldmljZXMnO1xuXG5jb25zdCBoZWFkZXJzID0ge1xuICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJzogJyonLFxuICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctSGVhZGVycyc6ICdDb250ZW50LVR5cGUsQXV0aG9yaXphdGlvbicsXG4gICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1NZXRob2RzJzogJ0dFVCxQT1NULFBVVCxERUxFVEUsT1BUSU9OUycsXG59O1xuXG5jb25zdCBWQUxJRF9HUk9VUFMgPSBbJ0FkbWluJywgJ1NhbGVzJywgJ0ZpZWxkRW5naW5lZXJpbmcnLCAnVmlld2VyJ107XG5cbmZ1bmN0aW9uIGlzQWRtaW4oZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50VjJXaXRoSldUQXV0aG9yaXplcik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IGV2ZW50LnJlcXVlc3RDb250ZXh0Py5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICBpZiAoIWNsYWltcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgZ3JvdXBzID0gY2xhaW1zWydjb2duaXRvOmdyb3VwcyddO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwcykpIHtcbiAgICAgIHJldHVybiBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZ3JvdXBzID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGdyb3VwcyA9PT0gJ0FkbWluJyB8fCBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmludGVyZmFjZSBVc2VySW5mbyB7XG4gIHVzZXJuYW1lOiBzdHJpbmc7XG4gIGVtYWlsOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIGNyZWF0ZWRfYXQ6IHN0cmluZztcbiAgZ3JvdXBzOiBzdHJpbmdbXTtcbiAgYXNzaWduZWRfZGV2aWNlcz86IHN0cmluZ1tdO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsaXN0VXNlcnMoKTogUHJvbWlzZTxVc2VySW5mb1tdPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgTGlzdFVzZXJzQ29tbWFuZCh7XG4gICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgIExpbWl0OiA2MCxcbiAgfSkpO1xuXG4gIGNvbnN0IHVzZXJzOiBVc2VySW5mb1tdID0gW107XG5cbiAgZm9yIChjb25zdCB1c2VyIG9mIHJlc3VsdC5Vc2VycyB8fCBbXSkge1xuICAgIGNvbnN0IGVtYWlsQXR0ciA9IHVzZXIuQXR0cmlidXRlcz8uZmluZCgoYTogQXR0cmlidXRlVHlwZSkgPT4gYS5OYW1lID09PSAnZW1haWwnKTtcbiAgICBjb25zdCBuYW1lQXR0ciA9IHVzZXIuQXR0cmlidXRlcz8uZmluZCgoYTogQXR0cmlidXRlVHlwZSkgPT4gYS5OYW1lID09PSAnbmFtZScpO1xuXG4gICAgLy8gR2V0IGdyb3VwcyBmb3IgdGhpcyB1c2VyXG4gICAgY29uc3QgZ3JvdXBzUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkxpc3RHcm91cHNGb3JVc2VyQ29tbWFuZCh7XG4gICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICBVc2VybmFtZTogdXNlci5Vc2VybmFtZSEsXG4gICAgfSkpO1xuXG4gICAgY29uc3QgZ3JvdXBzID0gKGdyb3Vwc1Jlc3VsdC5Hcm91cHMgfHwgW10pLm1hcCgoZzogR3JvdXBUeXBlKSA9PiBnLkdyb3VwTmFtZSEpO1xuXG4gICAgdXNlcnMucHVzaCh7XG4gICAgICB1c2VybmFtZTogdXNlci5Vc2VybmFtZSEsXG4gICAgICBlbWFpbDogZW1haWxBdHRyPy5WYWx1ZSB8fCAnJyxcbiAgICAgIG5hbWU6IG5hbWVBdHRyPy5WYWx1ZSB8fCAnJyxcbiAgICAgIHN0YXR1czogdXNlci5Vc2VyU3RhdHVzIHx8ICdVTktOT1dOJyxcbiAgICAgIGNyZWF0ZWRfYXQ6IHVzZXIuVXNlckNyZWF0ZURhdGU/LnRvSVNPU3RyaW5nKCkgfHwgJycsXG4gICAgICBncm91cHMsXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gdXNlcnM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldERldmljZXNBc3NpZ25lZFRvVXNlcih1c2VyRW1haWw6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFNjYW5Db21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgRmlsdGVyRXhwcmVzc2lvbjogJ2Fzc2lnbmVkX3RvID0gOmVtYWlsJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmVtYWlsJzogdXNlckVtYWlsLFxuICAgIH0sXG4gICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkJyxcbiAgfSkpO1xuXG4gIHJldHVybiAocmVzdWx0Lkl0ZW1zIHx8IFtdKS5tYXAoKGl0ZW06IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBpdGVtLmRldmljZV91aWQgYXMgc3RyaW5nKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXNzaWduRGV2aWNlVG9Vc2VyKGRldmljZVVpZDogc3RyaW5nLCB1c2VyRW1haWw6IHN0cmluZywgdXNlck5hbWU/OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gRmlyc3QsIHVuYXNzaWduIGFueSBkZXZpY2UgY3VycmVudGx5IGFzc2lnbmVkIHRvIHRoaXMgdXNlciAoc2luZ2xlIGRldmljZSBwZXIgdXNlcilcbiAgY29uc3QgY3VycmVudERldmljZXMgPSBhd2FpdCBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIodXNlckVtYWlsKTtcbiAgaWYgKGN1cnJlbnREZXZpY2VzLmxlbmd0aCA+IDApIHtcbiAgICBhd2FpdCB1bmFzc2lnbkRldmljZXNGcm9tVXNlcihjdXJyZW50RGV2aWNlcyk7XG4gIH1cblxuICAvLyBOb3cgYXNzaWduIHRoZSBuZXcgZGV2aWNlIHdpdGggYm90aCBlbWFpbCBhbmQgbmFtZVxuICBjb25zdCB1cGRhdGVFeHByZXNzaW9uID0gdXNlck5hbWVcbiAgICA/ICdTRVQgYXNzaWduZWRfdG8gPSA6ZW1haWwsIGFzc2lnbmVkX3RvX25hbWUgPSA6bmFtZSwgdXBkYXRlZF9hdCA9IDpub3cnXG4gICAgOiAnU0VUIGFzc2lnbmVkX3RvID0gOmVtYWlsLCB1cGRhdGVkX2F0ID0gOm5vdyc7XG5cbiAgY29uc3QgZXhwcmVzc2lvblZhbHVlczogUmVjb3JkPHN0cmluZywgYW55PiA9IHtcbiAgICAnOmVtYWlsJzogdXNlckVtYWlsLFxuICAgICc6bm93JzogRGF0ZS5ub3coKSxcbiAgfTtcblxuICBpZiAodXNlck5hbWUpIHtcbiAgICBleHByZXNzaW9uVmFsdWVzWyc6bmFtZSddID0gdXNlck5hbWU7XG4gIH1cblxuICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICBVcGRhdGVFeHByZXNzaW9uOiB1cGRhdGVFeHByZXNzaW9uLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IGV4cHJlc3Npb25WYWx1ZXMsXG4gIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0VW5hc3NpZ25lZERldmljZXMoKTogUHJvbWlzZTx7IGRldmljZV91aWQ6IHN0cmluZzsgc2VyaWFsX251bWJlcjogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH1bXT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgU2NhbkNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBGaWx0ZXJFeHByZXNzaW9uOiAnYXR0cmlidXRlX25vdF9leGlzdHMoYXNzaWduZWRfdG8pIE9SIGFzc2lnbmVkX3RvID0gOmVtcHR5JyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAnOmVtcHR5JzogJycsXG4gICAgfSxcbiAgICBQcm9qZWN0aW9uRXhwcmVzc2lvbjogJ2RldmljZV91aWQsIHNlcmlhbF9udW1iZXIsICNuJyxcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlTmFtZXM6IHtcbiAgICAgICcjbic6ICduYW1lJyxcbiAgICB9LFxuICB9KSk7XG5cbiAgcmV0dXJuIChyZXN1bHQuSXRlbXMgfHwgW10pLm1hcCgoaXRlbTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+ICh7XG4gICAgZGV2aWNlX3VpZDogaXRlbS5kZXZpY2VfdWlkIGFzIHN0cmluZyxcbiAgICBzZXJpYWxfbnVtYmVyOiBpdGVtLnNlcmlhbF9udW1iZXIgYXMgc3RyaW5nLFxuICAgIG5hbWU6IGl0ZW0ubmFtZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIH0pKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdW5hc3NpZ25EZXZpY2VzRnJvbVVzZXIoZGV2aWNlVWlkczogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgZm9yIChjb25zdCBkZXZpY2VVaWQgb2YgZGV2aWNlVWlkcykge1xuICAgIGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBVcGRhdGVDb21tYW5kKHtcbiAgICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICAgIEtleTogeyBkZXZpY2VfdWlkOiBkZXZpY2VVaWQgfSxcbiAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdSRU1PVkUgYXNzaWduZWRfdG8sIGFzc2lnbmVkX3RvX25hbWUgU0VUIHVwZGF0ZWRfYXQgPSA6bm93JyxcbiAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgJzpub3cnOiBEYXRlLm5vdygpLFxuICAgICAgfSxcbiAgICB9KSk7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQ6IEFQSUdhdGV3YXlQcm94eUV2ZW50VjJXaXRoSldUQXV0aG9yaXplcik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0VjI+IHtcbiAgY29uc29sZS5sb2coJ0V2ZW50OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50LCBudWxsLCAyKSk7XG5cbiAgY29uc3QgbWV0aG9kID0gZXZlbnQucmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2Q7XG4gIGNvbnN0IHBhdGggPSBldmVudC5yYXdQYXRoO1xuXG4gIC8vIEhhbmRsZSBPUFRJT05TIGZvciBDT1JTXG4gIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgIHJldHVybiB7IHN0YXR1c0NvZGU6IDIwMCwgaGVhZGVycywgYm9keTogJycgfTtcbiAgfVxuXG4gIC8vIEFsbCB1c2VyIG1hbmFnZW1lbnQgZW5kcG9pbnRzIHJlcXVpcmUgYWRtaW5cbiAgaWYgKCFpc0FkbWluKGV2ZW50KSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDMsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIGFjY2VzcyByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gR0VUIC92MS91c2VycyAtIExpc3QgYWxsIHVzZXJzXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgcGF0aCA9PT0gJy92MS91c2VycycpIHtcbiAgICAgIGNvbnN0IHVzZXJzID0gYXdhaXQgbGlzdFVzZXJzKCk7XG5cbiAgICAgIC8vIE9wdGlvbmFsbHkgaW5jbHVkZSBhc3NpZ25lZCBkZXZpY2VzIGZvciBlYWNoIHVzZXJcbiAgICAgIGNvbnN0IGluY2x1ZGVEZXZpY2VzID0gZXZlbnQucXVlcnlTdHJpbmdQYXJhbWV0ZXJzPy5pbmNsdWRlX2RldmljZXMgPT09ICd0cnVlJztcbiAgICAgIGlmIChpbmNsdWRlRGV2aWNlcykge1xuICAgICAgICBmb3IgKGNvbnN0IHVzZXIgb2YgdXNlcnMpIHtcbiAgICAgICAgICB1c2VyLmFzc2lnbmVkX2RldmljZXMgPSBhd2FpdCBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIodXNlci5lbWFpbCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHVzZXJzIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL3YxL3VzZXJzL2dyb3VwcyAtIExpc3QgYXZhaWxhYmxlIGdyb3Vwc1xuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHBhdGggPT09ICcvdjEvdXNlcnMvZ3JvdXBzJykge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBMaXN0R3JvdXBzQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgZ3JvdXBzID0gKHJlc3VsdC5Hcm91cHMgfHwgW10pLm1hcCgoZzogR3JvdXBUeXBlKSA9PiAoe1xuICAgICAgICBuYW1lOiBnLkdyb3VwTmFtZSxcbiAgICAgICAgZGVzY3JpcHRpb246IGcuRGVzY3JpcHRpb24sXG4gICAgICB9KSk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBncm91cHMgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEdFVCAvdjEvdXNlcnMve3VzZXJJZH0gLSBHZXQgc3BlY2lmaWMgdXNlclxuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHBhdGgubWF0Y2goL15cXC92MVxcL3VzZXJzXFwvW14vXSskLykpIHtcbiAgICAgIGNvbnN0IHVzZXJJZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy51c2VySWQ7XG4gICAgICBpZiAoIXVzZXJJZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdVc2VyIElEIHJlcXVpcmVkJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgdXNlclJlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5HZXRVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgZ3JvdXBzUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkxpc3RHcm91cHNGb3JVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgZW1haWxBdHRyID0gdXNlclJlc3VsdC5Vc2VyQXR0cmlidXRlcz8uZmluZCgoYTogQXR0cmlidXRlVHlwZSkgPT4gYS5OYW1lID09PSAnZW1haWwnKTtcbiAgICAgIGNvbnN0IG5hbWVBdHRyID0gdXNlclJlc3VsdC5Vc2VyQXR0cmlidXRlcz8uZmluZCgoYTogQXR0cmlidXRlVHlwZSkgPT4gYS5OYW1lID09PSAnbmFtZScpO1xuICAgICAgY29uc3QgZ3JvdXBzID0gKGdyb3Vwc1Jlc3VsdC5Hcm91cHMgfHwgW10pLm1hcCgoZzogR3JvdXBUeXBlKSA9PiBnLkdyb3VwTmFtZSEpO1xuXG4gICAgICBjb25zdCBhc3NpZ25lZERldmljZXMgPSBhd2FpdCBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIoZW1haWxBdHRyPy5WYWx1ZSB8fCAnJyk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHVzZXJuYW1lOiB1c2VyUmVzdWx0LlVzZXJuYW1lLFxuICAgICAgICAgIGVtYWlsOiBlbWFpbEF0dHI/LlZhbHVlIHx8ICcnLFxuICAgICAgICAgIG5hbWU6IG5hbWVBdHRyPy5WYWx1ZSB8fCAnJyxcbiAgICAgICAgICBzdGF0dXM6IHVzZXJSZXN1bHQuVXNlclN0YXR1cyxcbiAgICAgICAgICBjcmVhdGVkX2F0OiB1c2VyUmVzdWx0LlVzZXJDcmVhdGVEYXRlPy50b0lTT1N0cmluZygpLFxuICAgICAgICAgIGdyb3VwcyxcbiAgICAgICAgICBhc3NpZ25lZF9kZXZpY2VzOiBhc3NpZ25lZERldmljZXMsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBQT1NUIC92MS91c2VycyAtIEludml0ZSBuZXcgdXNlclxuICAgIGlmIChtZXRob2QgPT09ICdQT1NUJyAmJiBwYXRoID09PSAnL3YxL3VzZXJzJykge1xuICAgICAgbGV0IGJvZHk6IHtcbiAgICAgICAgZW1haWw6IHN0cmluZztcbiAgICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgICBncm91cDogc3RyaW5nO1xuICAgICAgICBkZXZpY2VfdWlkcz86IHN0cmluZ1tdO1xuICAgICAgfTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYm9keSA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSB8fCAne30nKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04gYm9keScgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIHJlcXVpcmVkIGZpZWxkc1xuICAgICAgaWYgKCFib2R5LmVtYWlsIHx8ICFib2R5Lm5hbWUgfHwgIWJvZHkuZ3JvdXApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnZW1haWwsIG5hbWUsIGFuZCBncm91cCBhcmUgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBncm91cFxuICAgICAgaWYgKCFWQUxJRF9HUk9VUFMuaW5jbHVkZXMoYm9keS5ncm91cCkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBgZ3JvdXAgbXVzdCBiZSBvbmUgb2Y6ICR7VkFMSURfR1JPVVBTLmpvaW4oJywgJyl9YCB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gQ3JlYXRlIHVzZXIgaW4gQ29nbml0b1xuICAgICAgY29uc3QgY3JlYXRlUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkNyZWF0ZVVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogYm9keS5lbWFpbCxcbiAgICAgICAgVXNlckF0dHJpYnV0ZXM6IFtcbiAgICAgICAgICB7IE5hbWU6ICdlbWFpbCcsIFZhbHVlOiBib2R5LmVtYWlsIH0sXG4gICAgICAgICAgeyBOYW1lOiAnZW1haWxfdmVyaWZpZWQnLCBWYWx1ZTogJ3RydWUnIH0sXG4gICAgICAgICAgeyBOYW1lOiAnbmFtZScsIFZhbHVlOiBib2R5Lm5hbWUgfSxcbiAgICAgICAgXSxcbiAgICAgICAgRGVzaXJlZERlbGl2ZXJ5TWVkaXVtczogWydFTUFJTCddLFxuICAgICAgfSkpO1xuXG4gICAgICAvLyBBZGQgdXNlciB0byBncm91cFxuICAgICAgYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkFkZFVzZXJUb0dyb3VwQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IGJvZHkuZW1haWwsXG4gICAgICAgIEdyb3VwTmFtZTogYm9keS5ncm91cCxcbiAgICAgIH0pKTtcblxuICAgICAgLy8gQXNzaWduIGRldmljZSBpZiBwcm92aWRlZCAob25seSBvbmUgZGV2aWNlIHBlciB1c2VyKVxuICAgICAgaWYgKGJvZHkuZGV2aWNlX3VpZHMgJiYgYm9keS5kZXZpY2VfdWlkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIC8vIE9ubHkgYXNzaWduIHRoZSBmaXJzdCBkZXZpY2UgKHNpbmdsZSBkZXZpY2UgcGVyIHVzZXIpXG4gICAgICAgIGF3YWl0IGFzc2lnbkRldmljZVRvVXNlcihib2R5LmRldmljZV91aWRzWzBdLCBib2R5LmVtYWlsLCBib2R5Lm5hbWUpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDEsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB1c2VybmFtZTogY3JlYXRlUmVzdWx0LlVzZXI/LlVzZXJuYW1lLFxuICAgICAgICAgIGVtYWlsOiBib2R5LmVtYWlsLFxuICAgICAgICAgIG5hbWU6IGJvZHkubmFtZSxcbiAgICAgICAgICBncm91cHM6IFtib2R5Lmdyb3VwXSxcbiAgICAgICAgICBhc3NpZ25lZF9kZXZpY2VzOiBib2R5LmRldmljZV91aWRzIHx8IFtdLFxuICAgICAgICAgIHN0YXR1czogY3JlYXRlUmVzdWx0LlVzZXI/LlVzZXJTdGF0dXMsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBQVVQgL3YxL3VzZXJzL3t1c2VySWR9L2dyb3VwcyAtIFVwZGF0ZSB1c2VyIGdyb3Vwc1xuICAgIGlmIChtZXRob2QgPT09ICdQVVQnICYmIHBhdGgubWF0Y2goL15cXC92MVxcL3VzZXJzXFwvW14vXStcXC9ncm91cHMkLykpIHtcbiAgICAgIGNvbnN0IHVzZXJJZCA9IGV2ZW50LnBhdGhQYXJhbWV0ZXJzPy51c2VySWQ7XG4gICAgICBpZiAoIXVzZXJJZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdVc2VyIElEIHJlcXVpcmVkJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgbGV0IGJvZHk6IHsgZ3JvdXBzOiBzdHJpbmdbXSB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgYm9keSA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSB8fCAne30nKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04gYm9keScgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGlmICghYm9keS5ncm91cHMgfHwgIUFycmF5LmlzQXJyYXkoYm9keS5ncm91cHMpKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ2dyb3VwcyBhcnJheSByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIGFsbCBncm91cHNcbiAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgYm9keS5ncm91cHMpIHtcbiAgICAgICAgaWYgKCFWQUxJRF9HUk9VUFMuaW5jbHVkZXMoZ3JvdXApKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBgSW52YWxpZCBncm91cDogJHtncm91cH0uIE11c3QgYmUgb25lIG9mOiAke1ZBTElEX0dST1VQUy5qb2luKCcsICcpfWAgfSksXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBHZXQgY3VycmVudCBncm91cHNcbiAgICAgIGNvbnN0IGN1cnJlbnRHcm91cHNSZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IEFkbWluTGlzdEdyb3Vwc0ZvclVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgfSkpO1xuICAgICAgY29uc3QgY3VycmVudEdyb3VwcyA9IChjdXJyZW50R3JvdXBzUmVzdWx0Lkdyb3VwcyB8fCBbXSkubWFwKChnOiBHcm91cFR5cGUpID0+IGcuR3JvdXBOYW1lISk7XG5cbiAgICAgIC8vIFJlbW92ZSBmcm9tIGdyb3VwcyBubyBsb25nZXIgaW4gbGlzdFxuICAgICAgZm9yIChjb25zdCBncm91cCBvZiBjdXJyZW50R3JvdXBzKSB7XG4gICAgICAgIGlmICghYm9keS5ncm91cHMuaW5jbHVkZXMoZ3JvdXApKSB7XG4gICAgICAgICAgYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pblJlbW92ZVVzZXJGcm9tR3JvdXBDb21tYW5kKHtcbiAgICAgICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgICAgIFVzZXJuYW1lOiB1c2VySWQsXG4gICAgICAgICAgICBHcm91cE5hbWU6IGdyb3VwLFxuICAgICAgICAgIH0pKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgdG8gbmV3IGdyb3Vwc1xuICAgICAgZm9yIChjb25zdCBncm91cCBvZiBib2R5Lmdyb3Vwcykge1xuICAgICAgICBpZiAoIWN1cnJlbnRHcm91cHMuaW5jbHVkZXMoZ3JvdXApKSB7XG4gICAgICAgICAgYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkFkZFVzZXJUb0dyb3VwQ29tbWFuZCh7XG4gICAgICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgICAgICAgR3JvdXBOYW1lOiBncm91cCxcbiAgICAgICAgICB9KSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgICAgICBncm91cHM6IGJvZHkuZ3JvdXBzLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUFVUIC92MS91c2Vycy97dXNlcklkfS9kZXZpY2UgLSBVcGRhdGUgdXNlcidzIGFzc2lnbmVkIGRldmljZSAoc2luZ2xlIGRldmljZSBwZXIgdXNlcilcbiAgICBpZiAobWV0aG9kID09PSAnUFVUJyAmJiBwYXRoLm1hdGNoKC9eXFwvdjFcXC91c2Vyc1xcL1teL10rXFwvZGV2aWNlJC8pKSB7XG4gICAgICBjb25zdCB1c2VySWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8udXNlcklkO1xuICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVXNlciBJRCByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGxldCBib2R5OiB7IGRldmljZV91aWQ6IHN0cmluZyB8IG51bGwgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkgfHwgJ3t9Jyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBKU09OIGJvZHknIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBHZXQgdXNlcidzIGVtYWlsIGFuZCBuYW1lXG4gICAgICBjb25zdCB1c2VyUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkdldFVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgfSkpO1xuICAgICAgY29uc3QgZW1haWxBdHRyID0gdXNlclJlc3VsdC5Vc2VyQXR0cmlidXRlcz8uZmluZCgoYTogQXR0cmlidXRlVHlwZSkgPT4gYS5OYW1lID09PSAnZW1haWwnKTtcbiAgICAgIGNvbnN0IG5hbWVBdHRyID0gdXNlclJlc3VsdC5Vc2VyQXR0cmlidXRlcz8uZmluZCgoYTogQXR0cmlidXRlVHlwZSkgPT4gYS5OYW1lID09PSAnbmFtZScpO1xuICAgICAgY29uc3QgdXNlckVtYWlsID0gZW1haWxBdHRyPy5WYWx1ZSB8fCAnJztcbiAgICAgIGNvbnN0IHVzZXJOYW1lID0gbmFtZUF0dHI/LlZhbHVlO1xuXG4gICAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdVc2VyIGVtYWlsIG5vdCBmb3VuZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIEdldCBjdXJyZW50bHkgYXNzaWduZWQgZGV2aWNlXG4gICAgICBjb25zdCBjdXJyZW50RGV2aWNlcyA9IGF3YWl0IGdldERldmljZXNBc3NpZ25lZFRvVXNlcih1c2VyRW1haWwpO1xuXG4gICAgICAvLyBVbmFzc2lnbiBjdXJyZW50IGRldmljZSBpZiBhbnlcbiAgICAgIGlmIChjdXJyZW50RGV2aWNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IHVuYXNzaWduRGV2aWNlc0Zyb21Vc2VyKGN1cnJlbnREZXZpY2VzKTtcbiAgICAgIH1cblxuICAgICAgLy8gQXNzaWduIG5ldyBkZXZpY2UgaWYgcHJvdmlkZWRcbiAgICAgIGlmIChib2R5LmRldmljZV91aWQpIHtcbiAgICAgICAgYXdhaXQgYXNzaWduRGV2aWNlVG9Vc2VyKGJvZHkuZGV2aWNlX3VpZCwgdXNlckVtYWlsLCB1c2VyTmFtZSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHVzZXJuYW1lOiB1c2VySWQsXG4gICAgICAgICAgZW1haWw6IHVzZXJFbWFpbCxcbiAgICAgICAgICBhc3NpZ25lZF9kZXZpY2U6IGJvZHkuZGV2aWNlX3VpZCB8fCBudWxsLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR0VUIC92MS9kZXZpY2VzL3VuYXNzaWduZWQgLSBHZXQgZGV2aWNlcyBub3QgYXNzaWduZWQgdG8gYW55IHVzZXJcbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiBwYXRoID09PSAnL3YxL2RldmljZXMvdW5hc3NpZ25lZCcpIHtcbiAgICAgIGNvbnN0IGRldmljZXMgPSBhd2FpdCBnZXRVbmFzc2lnbmVkRGV2aWNlcygpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZGV2aWNlcyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUE9TVCAvdjEvdXNlcnMve3VzZXJJZH0vY29uZmlybSAtIENvbmZpcm0gYW4gdW5jb25maXJtZWQgdXNlclxuICAgIGlmIChtZXRob2QgPT09ICdQT1NUJyAmJiBwYXRoLm1hdGNoKC9eXFwvdjFcXC91c2Vyc1xcL1teL10rXFwvY29uZmlybSQvKSkge1xuICAgICAgY29uc3QgdXNlcklkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnVzZXJJZDtcbiAgICAgIGlmICghdXNlcklkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1VzZXIgSUQgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBDb25maXJtIHRoZSB1c2VyIGluIENvZ25pdG9cbiAgICAgIGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5Db25maXJtU2lnblVwQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgbWVzc2FnZTogJ1VzZXIgY29uZmlybWVkIHN1Y2Nlc3NmdWxseScsXG4gICAgICAgICAgdXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIERFTEVURSAvdjEvdXNlcnMve3VzZXJJZH0gLSBEZWxldGUgYSB1c2VyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0RFTEVURScgJiYgcGF0aC5tYXRjaCgvXlxcL3YxXFwvdXNlcnNcXC9bXi9dKyQvKSkge1xuICAgICAgY29uc3QgdXNlcklkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnVzZXJJZDtcbiAgICAgIGlmICghdXNlcklkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1VzZXIgSUQgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBHZXQgdXNlcidzIGVtYWlsIHRvIHVuYXNzaWduIGRldmljZXNcbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IEFkbWluR2V0VXNlckNvbW1hbmQoe1xuICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgIFVzZXJuYW1lOiB1c2VySWQsXG4gICAgICB9KSk7XG4gICAgICBjb25zdCBlbWFpbEF0dHIgPSB1c2VyUmVzdWx0LlVzZXJBdHRyaWJ1dGVzPy5maW5kKChhOiBBdHRyaWJ1dGVUeXBlKSA9PiBhLk5hbWUgPT09ICdlbWFpbCcpO1xuICAgICAgY29uc3QgdXNlckVtYWlsID0gZW1haWxBdHRyPy5WYWx1ZSB8fCAnJztcblxuICAgICAgLy8gVW5hc3NpZ24gYW55IGRldmljZXMgYXNzaWduZWQgdG8gdGhpcyB1c2VyXG4gICAgICBpZiAodXNlckVtYWlsKSB7XG4gICAgICAgIGNvbnN0IGFzc2lnbmVkRGV2aWNlcyA9IGF3YWl0IGdldERldmljZXNBc3NpZ25lZFRvVXNlcih1c2VyRW1haWwpO1xuICAgICAgICBpZiAoYXNzaWduZWREZXZpY2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBhd2FpdCB1bmFzc2lnbkRldmljZXNGcm9tVXNlcihhc3NpZ25lZERldmljZXMpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIERlbGV0ZSB0aGUgdXNlciBmcm9tIENvZ25pdG9cbiAgICAgIGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5EZWxldGVVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgbWVzc2FnZTogJ1VzZXIgZGVsZXRlZCBzdWNjZXNzZnVsbHknLFxuICAgICAgICAgIHVzZXJuYW1lOiB1c2VySWQsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdOb3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ0ludGVybmFsIHNlcnZlciBlcnJvcic7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlcnJvck1lc3NhZ2UgfSksXG4gICAgfTtcbiAgfVxufVxuIl19