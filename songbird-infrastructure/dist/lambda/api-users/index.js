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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLXVzZXJzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7O0FBRUgsZ0dBYW1EO0FBQ25ELDhEQUEwRDtBQUMxRCx3REFBMkY7QUFHM0YsTUFBTSxhQUFhLEdBQUcsSUFBSSxnRUFBNkIsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUM1RCxNQUFNLFlBQVksR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDNUMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBRTVELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztBQUNwRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsSUFBSSxrQkFBa0IsQ0FBQztBQUV0RSxNQUFNLE9BQU8sR0FBRztJQUNkLGNBQWMsRUFBRSxrQkFBa0I7SUFDbEMsNkJBQTZCLEVBQUUsR0FBRztJQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7SUFDNUQsOEJBQThCLEVBQUUsNkJBQTZCO0NBQzlELENBQUM7QUFFRixNQUFNLFlBQVksR0FBRyxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFFdEUsU0FBUyxPQUFPLENBQUMsS0FBOEM7SUFDN0QsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE1BQU0sQ0FBQztRQUM3RCxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBRTFCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3hDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENB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QUM7b0JBQy9CLE1BQU0sdUJBQXVCLENBQUMsZUFBZSxDQUFDLENBQUM7Z0JBQ2pELENBQUM7WUFDSCxDQUFDO1lBRUQsK0JBQStCO1lBQy9CLE1BQU0sYUFBYSxDQUFDLElBQUksQ0FBQyxJQUFJLHlEQUFzQixDQUFDO2dCQUNsRCxVQUFVLEVBQUUsWUFBWTtnQkFDeEIsUUFBUSxFQUFFLE1BQU07YUFDakIsQ0FBQyxDQUFDLENBQUM7WUFFSixPQUFPO2dCQUNMLFVBQVUsRUFBRSxHQUFHO2dCQUNmLE9BQU87Z0JBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7b0JBQ25CLE9BQU8sRUFBRSwyQkFBMkI7b0JBQ3BDLFFBQVEsRUFBRSxNQUFNO2lCQUNqQixDQUFDO2FBQ0gsQ0FBQztRQUNKLENBQUM7UUFFRCxPQUFPO1lBQ0wsVUFBVSxFQUFFLEdBQUc7WUFDZixPQUFPO1lBQ1AsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLENBQUM7U0FDN0MsQ0FBQztJQUNKLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxDQUFDLEtBQUssQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDL0IsTUFBTSxZQUFZLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsdUJBQXVCLENBQUM7UUFDdEYsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRSxDQUFDO1NBQzlDLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQXBZRCwwQkFvWUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFQSSBVc2VycyBMYW1iZGFcbiAqXG4gKiBIYW5kbGVzIHVzZXIgbWFuYWdlbWVudCBvcGVyYXRpb25zIHVzaW5nIENvZ25pdG8gQWRtaW4gQVBJcy5cbiAqIEFsbCBlbmRwb2ludHMgYXJlIGFkbWluLW9ubHkuXG4gKi9cblxuaW1wb3J0IHtcbiAgQ29nbml0b0lkZW50aXR5UHJvdmlkZXJDbGllbnQsXG4gIExpc3RVc2Vyc0NvbW1hbmQsXG4gIEFkbWluQ3JlYXRlVXNlckNvbW1hbmQsXG4gIEFkbWluQWRkVXNlclRvR3JvdXBDb21tYW5kLFxuICBBZG1pblJlbW92ZVVzZXJGcm9tR3JvdXBDb21tYW5kLFxuICBBZG1pbkxpc3RHcm91cHNGb3JVc2VyQ29tbWFuZCxcbiAgQWRtaW5HZXRVc2VyQ29tbWFuZCxcbiAgQWRtaW5VcGRhdGVVc2VyQXR0cmlidXRlc0NvbW1hbmQsXG4gIEFkbWluRGVsZXRlVXNlckNvbW1hbmQsXG4gIExpc3RHcm91cHNDb21tYW5kLFxuICB0eXBlIEF0dHJpYnV0ZVR5cGUsXG4gIHR5cGUgR3JvdXBUeXBlLFxufSBmcm9tICdAYXdzLXNkay9jbGllbnQtY29nbml0by1pZGVudGl0eS1wcm92aWRlcic7XG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBVcGRhdGVDb21tYW5kLCBTY2FuQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgdHlwZSB7IEFQSUdhdGV3YXlQcm94eUV2ZW50VjJXaXRoSldUQXV0aG9yaXplciwgQVBJR2F0ZXdheVByb3h5UmVzdWx0VjIgfSBmcm9tICdhd3MtbGFtYmRhJztcblxuY29uc3QgY29nbml0b0NsaWVudCA9IG5ldyBDb2duaXRvSWRlbnRpdHlQcm92aWRlckNsaWVudCh7fSk7XG5jb25zdCBkeW5hbW9DbGllbnQgPSBuZXcgRHluYW1vREJDbGllbnQoe30pO1xuY29uc3QgZG9jQ2xpZW50ID0gRHluYW1vREJEb2N1bWVudENsaWVudC5mcm9tKGR5bmFtb0NsaWVudCk7XG5cbmNvbnN0IFVTRVJfUE9PTF9JRCA9IHByb2Nlc3MuZW52LlVTRVJfUE9PTF9JRCB8fCAnJztcbmNvbnN0IERFVklDRVNfVEFCTEUgPSBwcm9jZXNzLmVudi5ERVZJQ0VTX1RBQkxFIHx8ICdzb25nYmlyZC1kZXZpY2VzJztcblxuY29uc3QgaGVhZGVycyA9IHtcbiAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU9yaWdpbic6ICcqJyxcbiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LUhlYWRlcnMnOiAnQ29udGVudC1UeXBlLEF1dGhvcml6YXRpb24nLFxuICAnQWNjZXNzLUNvbnRyb2wtQWxsb3ctTWV0aG9kcyc6ICdHRVQsUE9TVCxQVVQsREVMRVRFLE9QVElPTlMnLFxufTtcblxuY29uc3QgVkFMSURfR1JPVVBTID0gWydBZG1pbicsICdTYWxlcycsICdGaWVsZEVuZ2luZWVyaW5nJywgJ1ZpZXdlciddO1xuXG5mdW5jdGlvbiBpc0FkbWluKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudFYyV2l0aEpXVEF1dGhvcml6ZXIpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbGFpbXMgPSBldmVudC5yZXF1ZXN0Q29udGV4dD8uYXV0aG9yaXplcj8uand0Py5jbGFpbXM7XG4gICAgaWYgKCFjbGFpbXMpIHJldHVybiBmYWxzZTtcblxuICAgIGNvbnN0IGdyb3VwcyA9IGNsYWltc1snY29nbml0bzpncm91cHMnXTtcbiAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cHMpKSB7XG4gICAgICByZXR1cm4gZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIGdyb3VwcyA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBncm91cHMgPT09ICdBZG1pbicgfHwgZ3JvdXBzLmluY2x1ZGVzKCdBZG1pbicpO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG5pbnRlcmZhY2UgVXNlckluZm8ge1xuICB1c2VybmFtZTogc3RyaW5nO1xuICBlbWFpbDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICBjcmVhdGVkX2F0OiBzdHJpbmc7XG4gIGdyb3Vwczogc3RyaW5nW107XG4gIGFzc2lnbmVkX2RldmljZXM/OiBzdHJpbmdbXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbGlzdFVzZXJzKCk6IFByb21pc2U8VXNlckluZm9bXT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IExpc3RVc2Vyc0NvbW1hbmQoe1xuICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICBMaW1pdDogNjAsXG4gIH0pKTtcblxuICBjb25zdCB1c2VyczogVXNlckluZm9bXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgdXNlciBvZiByZXN1bHQuVXNlcnMgfHwgW10pIHtcbiAgICBjb25zdCBlbWFpbEF0dHIgPSB1c2VyLkF0dHJpYnV0ZXM/LmZpbmQoKGE6IEF0dHJpYnV0ZVR5cGUpID0+IGEuTmFtZSA9PT0gJ2VtYWlsJyk7XG4gICAgY29uc3QgbmFtZUF0dHIgPSB1c2VyLkF0dHJpYnV0ZXM/LmZpbmQoKGE6IEF0dHJpYnV0ZVR5cGUpID0+IGEuTmFtZSA9PT0gJ25hbWUnKTtcblxuICAgIC8vIEdldCBncm91cHMgZm9yIHRoaXMgdXNlclxuICAgIGNvbnN0IGdyb3Vwc1Jlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5MaXN0R3JvdXBzRm9yVXNlckNvbW1hbmQoe1xuICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgVXNlcm5hbWU6IHVzZXIuVXNlcm5hbWUhLFxuICAgIH0pKTtcblxuICAgIGNvbnN0IGdyb3VwcyA9IChncm91cHNSZXN1bHQuR3JvdXBzIHx8IFtdKS5tYXAoKGc6IEdyb3VwVHlwZSkgPT4gZy5Hcm91cE5hbWUhKTtcblxuICAgIHVzZXJzLnB1c2goe1xuICAgICAgdXNlcm5hbWU6IHVzZXIuVXNlcm5hbWUhLFxuICAgICAgZW1haWw6IGVtYWlsQXR0cj8uVmFsdWUgfHwgJycsXG4gICAgICBuYW1lOiBuYW1lQXR0cj8uVmFsdWUgfHwgJycsXG4gICAgICBzdGF0dXM6IHVzZXIuVXNlclN0YXR1cyB8fCAnVU5LTk9XTicsXG4gICAgICBjcmVhdGVkX2F0OiB1c2VyLlVzZXJDcmVhdGVEYXRlPy50b0lTT1N0cmluZygpIHx8ICcnLFxuICAgICAgZ3JvdXBzLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHVzZXJzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIodXNlckVtYWlsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEZpbHRlckV4cHJlc3Npb246ICdhc3NpZ25lZF90byA9IDplbWFpbCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzplbWFpbCc6IHVzZXJFbWFpbCxcbiAgICB9LFxuICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCcsXG4gIH0pKTtcblxuICByZXR1cm4gKHJlc3VsdC5JdGVtcyB8fCBbXSkubWFwKChpdGVtOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gaXRlbS5kZXZpY2VfdWlkIGFzIHN0cmluZyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFzc2lnbkRldmljZVRvVXNlcihkZXZpY2VVaWQ6IHN0cmluZywgdXNlckVtYWlsOiBzdHJpbmcsIHVzZXJOYW1lPzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIEZpcnN0LCB1bmFzc2lnbiBhbnkgZGV2aWNlIGN1cnJlbnRseSBhc3NpZ25lZCB0byB0aGlzIHVzZXIgKHNpbmdsZSBkZXZpY2UgcGVyIHVzZXIpXG4gIGNvbnN0IGN1cnJlbnREZXZpY2VzID0gYXdhaXQgZ2V0RGV2aWNlc0Fzc2lnbmVkVG9Vc2VyKHVzZXJFbWFpbCk7XG4gIGlmIChjdXJyZW50RGV2aWNlcy5sZW5ndGggPiAwKSB7XG4gICAgYXdhaXQgdW5hc3NpZ25EZXZpY2VzRnJvbVVzZXIoY3VycmVudERldmljZXMpO1xuICB9XG5cbiAgLy8gTm93IGFzc2lnbiB0aGUgbmV3IGRldmljZSB3aXRoIGJvdGggZW1haWwgYW5kIG5hbWVcbiAgY29uc3QgdXBkYXRlRXhwcmVzc2lvbiA9IHVzZXJOYW1lXG4gICAgPyAnU0VUIGFzc2lnbmVkX3RvID0gOmVtYWlsLCBhc3NpZ25lZF90b19uYW1lID0gOm5hbWUsIHVwZGF0ZWRfYXQgPSA6bm93J1xuICAgIDogJ1NFVCBhc3NpZ25lZF90byA9IDplbWFpbCwgdXBkYXRlZF9hdCA9IDpub3cnO1xuXG4gIGNvbnN0IGV4cHJlc3Npb25WYWx1ZXM6IFJlY29yZDxzdHJpbmcsIGFueT4gPSB7XG4gICAgJzplbWFpbCc6IHVzZXJFbWFpbCxcbiAgICAnOm5vdyc6IERhdGUubm93KCksXG4gIH07XG5cbiAgaWYgKHVzZXJOYW1lKSB7XG4gICAgZXhwcmVzc2lvblZhbHVlc1snOm5hbWUnXSA9IHVzZXJOYW1lO1xuICB9XG5cbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZGV2aWNlVWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogdXBkYXRlRXhwcmVzc2lvbixcbiAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiBleHByZXNzaW9uVmFsdWVzLFxuICB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFVuYXNzaWduZWREZXZpY2VzKCk6IFByb21pc2U8eyBkZXZpY2VfdWlkOiBzdHJpbmc7IHNlcmlhbF9udW1iZXI6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9W10+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFNjYW5Db21tYW5kKHtcbiAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgRmlsdGVyRXhwcmVzc2lvbjogJ2F0dHJpYnV0ZV9ub3RfZXhpc3RzKGFzc2lnbmVkX3RvKSBPUiBhc3NpZ25lZF90byA9IDplbXB0eScsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzplbXB0eSc6ICcnLFxuICAgIH0sXG4gICAgUHJvamVjdGlvbkV4cHJlc3Npb246ICdkZXZpY2VfdWlkLCBzZXJpYWxfbnVtYmVyLCAjbicsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZU5hbWVzOiB7XG4gICAgICAnI24nOiAnbmFtZScsXG4gICAgfSxcbiAgfSkpO1xuXG4gIHJldHVybiAocmVzdWx0Lkl0ZW1zIHx8IFtdKS5tYXAoKGl0ZW06IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiAoe1xuICAgIGRldmljZV91aWQ6IGl0ZW0uZGV2aWNlX3VpZCBhcyBzdHJpbmcsXG4gICAgc2VyaWFsX251bWJlcjogaXRlbS5zZXJpYWxfbnVtYmVyIGFzIHN0cmluZyxcbiAgICBuYW1lOiBpdGVtLm5hbWUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVuYXNzaWduRGV2aWNlc0Zyb21Vc2VyKGRldmljZVVpZHM6IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG4gIGZvciAoY29uc3QgZGV2aWNlVWlkIG9mIGRldmljZVVpZHMpIHtcbiAgICBhd2FpdCBkb2NDbGllbnQuc2VuZChuZXcgVXBkYXRlQ29tbWFuZCh7XG4gICAgICBUYWJsZU5hbWU6IERFVklDRVNfVEFCTEUsXG4gICAgICBLZXk6IHsgZGV2aWNlX3VpZDogZGV2aWNlVWlkIH0sXG4gICAgICBVcGRhdGVFeHByZXNzaW9uOiAnUkVNT1ZFIGFzc2lnbmVkX3RvLCBhc3NpZ25lZF90b19uYW1lIFNFVCB1cGRhdGVkX2F0ID0gOm5vdycsXG4gICAgICBFeHByZXNzaW9uQXR0cmlidXRlVmFsdWVzOiB7XG4gICAgICAgICc6bm93JzogRGF0ZS5ub3coKSxcbiAgICAgIH0sXG4gICAgfSkpO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVyKGV2ZW50OiBBUElHYXRld2F5UHJveHlFdmVudFYyV2l0aEpXVEF1dGhvcml6ZXIpOiBQcm9taXNlPEFQSUdhdGV3YXlQcm94eVJlc3VsdFYyPiB7XG4gIGNvbnNvbGUubG9nKCdFdmVudDonLCBKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpO1xuXG4gIGNvbnN0IG1ldGhvZCA9IGV2ZW50LnJlcXVlc3RDb250ZXh0Lmh0dHAubWV0aG9kO1xuICBjb25zdCBwYXRoID0gZXZlbnQucmF3UGF0aDtcblxuICAvLyBIYW5kbGUgT1BUSU9OUyBmb3IgQ09SU1xuICBpZiAobWV0aG9kID09PSAnT1BUSU9OUycpIHtcbiAgICByZXR1cm4geyBzdGF0dXNDb2RlOiAyMDAsIGhlYWRlcnMsIGJvZHk6ICcnIH07XG4gIH1cblxuICAvLyBBbGwgdXNlciBtYW5hZ2VtZW50IGVuZHBvaW50cyByZXF1aXJlIGFkbWluXG4gIGlmICghaXNBZG1pbihldmVudCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDAzLFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdBZG1pbiBhY2Nlc3MgcmVxdWlyZWQnIH0pLFxuICAgIH07XG4gIH1cblxuICB0cnkge1xuICAgIC8vIEdFVCAvdjEvdXNlcnMgLSBMaXN0IGFsbCB1c2Vyc1xuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHBhdGggPT09ICcvdjEvdXNlcnMnKSB7XG4gICAgICBjb25zdCB1c2VycyA9IGF3YWl0IGxpc3RVc2VycygpO1xuXG4gICAgICAvLyBPcHRpb25hbGx5IGluY2x1ZGUgYXNzaWduZWQgZGV2aWNlcyBmb3IgZWFjaCB1c2VyXG4gICAgICBjb25zdCBpbmNsdWRlRGV2aWNlcyA9IGV2ZW50LnF1ZXJ5U3RyaW5nUGFyYW1ldGVycz8uaW5jbHVkZV9kZXZpY2VzID09PSAndHJ1ZSc7XG4gICAgICBpZiAoaW5jbHVkZURldmljZXMpIHtcbiAgICAgICAgZm9yIChjb25zdCB1c2VyIG9mIHVzZXJzKSB7XG4gICAgICAgICAgdXNlci5hc3NpZ25lZF9kZXZpY2VzID0gYXdhaXQgZ2V0RGV2aWNlc0Fzc2lnbmVkVG9Vc2VyKHVzZXIuZW1haWwpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB1c2VycyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR0VUIC92MS91c2Vycy9ncm91cHMgLSBMaXN0IGF2YWlsYWJsZSBncm91cHNcbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiBwYXRoID09PSAnL3YxL3VzZXJzL2dyb3VwcycpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgTGlzdEdyb3Vwc0NvbW1hbmQoe1xuICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICB9KSk7XG5cbiAgICAgIGNvbnN0IGdyb3VwcyA9IChyZXN1bHQuR3JvdXBzIHx8IFtdKS5tYXAoKGc6IEdyb3VwVHlwZSkgPT4gKHtcbiAgICAgICAgbmFtZTogZy5Hcm91cE5hbWUsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBnLkRlc2NyaXB0aW9uLFxuICAgICAgfSkpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZ3JvdXBzIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL3YxL3VzZXJzL3t1c2VySWR9IC0gR2V0IHNwZWNpZmljIHVzZXJcbiAgICBpZiAobWV0aG9kID09PSAnR0VUJyAmJiBwYXRoLm1hdGNoKC9eXFwvdjFcXC91c2Vyc1xcL1teL10rJC8pKSB7XG4gICAgICBjb25zdCB1c2VySWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8udXNlcklkO1xuICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVXNlciBJRCByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IEFkbWluR2V0VXNlckNvbW1hbmQoe1xuICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgIFVzZXJuYW1lOiB1c2VySWQsXG4gICAgICB9KSk7XG5cbiAgICAgIGNvbnN0IGdyb3Vwc1Jlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5MaXN0R3JvdXBzRm9yVXNlckNvbW1hbmQoe1xuICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgIFVzZXJuYW1lOiB1c2VySWQsXG4gICAgICB9KSk7XG5cbiAgICAgIGNvbnN0IGVtYWlsQXR0ciA9IHVzZXJSZXN1bHQuVXNlckF0dHJpYnV0ZXM/LmZpbmQoKGE6IEF0dHJpYnV0ZVR5cGUpID0+IGEuTmFtZSA9PT0gJ2VtYWlsJyk7XG4gICAgICBjb25zdCBuYW1lQXR0ciA9IHVzZXJSZXN1bHQuVXNlckF0dHJpYnV0ZXM/LmZpbmQoKGE6IEF0dHJpYnV0ZVR5cGUpID0+IGEuTmFtZSA9PT0gJ25hbWUnKTtcbiAgICAgIGNvbnN0IGdyb3VwcyA9IChncm91cHNSZXN1bHQuR3JvdXBzIHx8IFtdKS5tYXAoKGc6IEdyb3VwVHlwZSkgPT4gZy5Hcm91cE5hbWUhKTtcblxuICAgICAgY29uc3QgYXNzaWduZWREZXZpY2VzID0gYXdhaXQgZ2V0RGV2aWNlc0Fzc2lnbmVkVG9Vc2VyKGVtYWlsQXR0cj8uVmFsdWUgfHwgJycpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB1c2VybmFtZTogdXNlclJlc3VsdC5Vc2VybmFtZSxcbiAgICAgICAgICBlbWFpbDogZW1haWxBdHRyPy5WYWx1ZSB8fCAnJyxcbiAgICAgICAgICBuYW1lOiBuYW1lQXR0cj8uVmFsdWUgfHwgJycsXG4gICAgICAgICAgc3RhdHVzOiB1c2VyUmVzdWx0LlVzZXJTdGF0dXMsXG4gICAgICAgICAgY3JlYXRlZF9hdDogdXNlclJlc3VsdC5Vc2VyQ3JlYXRlRGF0ZT8udG9JU09TdHJpbmcoKSxcbiAgICAgICAgICBncm91cHMsXG4gICAgICAgICAgYXNzaWduZWRfZGV2aWNlczogYXNzaWduZWREZXZpY2VzLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUE9TVCAvdjEvdXNlcnMgLSBJbnZpdGUgbmV3IHVzZXJcbiAgICBpZiAobWV0aG9kID09PSAnUE9TVCcgJiYgcGF0aCA9PT0gJy92MS91c2VycycpIHtcbiAgICAgIGxldCBib2R5OiB7XG4gICAgICAgIGVtYWlsOiBzdHJpbmc7XG4gICAgICAgIG5hbWU6IHN0cmluZztcbiAgICAgICAgZ3JvdXA6IHN0cmluZztcbiAgICAgICAgZGV2aWNlX3VpZHM/OiBzdHJpbmdbXTtcbiAgICAgIH07XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkgfHwgJ3t9Jyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBKU09OIGJvZHknIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSByZXF1aXJlZCBmaWVsZHNcbiAgICAgIGlmICghYm9keS5lbWFpbCB8fCAhYm9keS5uYW1lIHx8ICFib2R5Lmdyb3VwKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ2VtYWlsLCBuYW1lLCBhbmQgZ3JvdXAgYXJlIHJlcXVpcmVkJyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgZ3JvdXBcbiAgICAgIGlmICghVkFMSURfR1JPVVBTLmluY2x1ZGVzKGJvZHkuZ3JvdXApKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogYGdyb3VwIG11c3QgYmUgb25lIG9mOiAke1ZBTElEX0dST1VQUy5qb2luKCcsICcpfWAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIENyZWF0ZSB1c2VyIGluIENvZ25pdG9cbiAgICAgIGNvbnN0IGNyZWF0ZVJlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5DcmVhdGVVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IGJvZHkuZW1haWwsXG4gICAgICAgIFVzZXJBdHRyaWJ1dGVzOiBbXG4gICAgICAgICAgeyBOYW1lOiAnZW1haWwnLCBWYWx1ZTogYm9keS5lbWFpbCB9LFxuICAgICAgICAgIHsgTmFtZTogJ2VtYWlsX3ZlcmlmaWVkJywgVmFsdWU6ICd0cnVlJyB9LFxuICAgICAgICAgIHsgTmFtZTogJ25hbWUnLCBWYWx1ZTogYm9keS5uYW1lIH0sXG4gICAgICAgIF0sXG4gICAgICAgIERlc2lyZWREZWxpdmVyeU1lZGl1bXM6IFsnRU1BSUwnXSxcbiAgICAgIH0pKTtcblxuICAgICAgLy8gQWRkIHVzZXIgdG8gZ3JvdXBcbiAgICAgIGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5BZGRVc2VyVG9Hcm91cENvbW1hbmQoe1xuICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgIFVzZXJuYW1lOiBib2R5LmVtYWlsLFxuICAgICAgICBHcm91cE5hbWU6IGJvZHkuZ3JvdXAsXG4gICAgICB9KSk7XG5cbiAgICAgIC8vIEFzc2lnbiBkZXZpY2UgaWYgcHJvdmlkZWQgKG9ubHkgb25lIGRldmljZSBwZXIgdXNlcilcbiAgICAgIGlmIChib2R5LmRldmljZV91aWRzICYmIGJvZHkuZGV2aWNlX3VpZHMubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBPbmx5IGFzc2lnbiB0aGUgZmlyc3QgZGV2aWNlIChzaW5nbGUgZGV2aWNlIHBlciB1c2VyKVxuICAgICAgICBhd2FpdCBhc3NpZ25EZXZpY2VUb1VzZXIoYm9keS5kZXZpY2VfdWlkc1swXSwgYm9keS5lbWFpbCwgYm9keS5uYW1lKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAxLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdXNlcm5hbWU6IGNyZWF0ZVJlc3VsdC5Vc2VyPy5Vc2VybmFtZSxcbiAgICAgICAgICBlbWFpbDogYm9keS5lbWFpbCxcbiAgICAgICAgICBuYW1lOiBib2R5Lm5hbWUsXG4gICAgICAgICAgZ3JvdXBzOiBbYm9keS5ncm91cF0sXG4gICAgICAgICAgYXNzaWduZWRfZGV2aWNlczogYm9keS5kZXZpY2VfdWlkcyB8fCBbXSxcbiAgICAgICAgICBzdGF0dXM6IGNyZWF0ZVJlc3VsdC5Vc2VyPy5Vc2VyU3RhdHVzLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUFVUIC92MS91c2Vycy97dXNlcklkfS9ncm91cHMgLSBVcGRhdGUgdXNlciBncm91cHNcbiAgICBpZiAobWV0aG9kID09PSAnUFVUJyAmJiBwYXRoLm1hdGNoKC9eXFwvdjFcXC91c2Vyc1xcL1teL10rXFwvZ3JvdXBzJC8pKSB7XG4gICAgICBjb25zdCB1c2VySWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8udXNlcklkO1xuICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVXNlciBJRCByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGxldCBib2R5OiB7IGdyb3Vwczogc3RyaW5nW10gfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkgfHwgJ3t9Jyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBKU09OIGJvZHknIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBpZiAoIWJvZHkuZ3JvdXBzIHx8ICFBcnJheS5pc0FycmF5KGJvZHkuZ3JvdXBzKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdncm91cHMgYXJyYXkgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBhbGwgZ3JvdXBzXG4gICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGJvZHkuZ3JvdXBzKSB7XG4gICAgICAgIGlmICghVkFMSURfR1JPVVBTLmluY2x1ZGVzKGdyb3VwKSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogYEludmFsaWQgZ3JvdXA6ICR7Z3JvdXB9LiBNdXN0IGJlIG9uZSBvZjogJHtWQUxJRF9HUk9VUFMuam9pbignLCAnKX1gIH0pLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gR2V0IGN1cnJlbnQgZ3JvdXBzXG4gICAgICBjb25zdCBjdXJyZW50R3JvdXBzUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkxpc3RHcm91cHNGb3JVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcbiAgICAgIGNvbnN0IGN1cnJlbnRHcm91cHMgPSAoY3VycmVudEdyb3Vwc1Jlc3VsdC5Hcm91cHMgfHwgW10pLm1hcCgoZzogR3JvdXBUeXBlKSA9PiBnLkdyb3VwTmFtZSEpO1xuXG4gICAgICAvLyBSZW1vdmUgZnJvbSBncm91cHMgbm8gbG9uZ2VyIGluIGxpc3RcbiAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgY3VycmVudEdyb3Vwcykge1xuICAgICAgICBpZiAoIWJvZHkuZ3JvdXBzLmluY2x1ZGVzKGdyb3VwKSkge1xuICAgICAgICAgIGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5SZW1vdmVVc2VyRnJvbUdyb3VwQ29tbWFuZCh7XG4gICAgICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgICAgICAgR3JvdXBOYW1lOiBncm91cCxcbiAgICAgICAgICB9KSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gQWRkIHRvIG5ldyBncm91cHNcbiAgICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgYm9keS5ncm91cHMpIHtcbiAgICAgICAgaWYgKCFjdXJyZW50R3JvdXBzLmluY2x1ZGVzKGdyb3VwKSkge1xuICAgICAgICAgIGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5BZGRVc2VyVG9Hcm91cENvbW1hbmQoe1xuICAgICAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgICAgICAgIEdyb3VwTmFtZTogZ3JvdXAsXG4gICAgICAgICAgfSkpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHVzZXJuYW1lOiB1c2VySWQsXG4gICAgICAgICAgZ3JvdXBzOiBib2R5Lmdyb3VwcyxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIFBVVCAvdjEvdXNlcnMve3VzZXJJZH0vZGV2aWNlIC0gVXBkYXRlIHVzZXIncyBhc3NpZ25lZCBkZXZpY2UgKHNpbmdsZSBkZXZpY2UgcGVyIHVzZXIpXG4gICAgaWYgKG1ldGhvZCA9PT0gJ1BVVCcgJiYgcGF0aC5tYXRjaCgvXlxcL3YxXFwvdXNlcnNcXC9bXi9dK1xcL2RldmljZSQvKSkge1xuICAgICAgY29uc3QgdXNlcklkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnVzZXJJZDtcbiAgICAgIGlmICghdXNlcklkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1VzZXIgSUQgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBsZXQgYm9keTogeyBkZXZpY2VfdWlkOiBzdHJpbmcgfCBudWxsIH07XG4gICAgICB0cnkge1xuICAgICAgICBib2R5ID0gSlNPTi5wYXJzZShldmVudC5ib2R5IHx8ICd7fScpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0ludmFsaWQgSlNPTiBib2R5JyB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gR2V0IHVzZXIncyBlbWFpbCBhbmQgbmFtZVxuICAgICAgY29uc3QgdXNlclJlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5HZXRVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcbiAgICAgIGNvbnN0IGVtYWlsQXR0ciA9IHVzZXJSZXN1bHQuVXNlckF0dHJpYnV0ZXM/LmZpbmQoKGE6IEF0dHJpYnV0ZVR5cGUpID0+IGEuTmFtZSA9PT0gJ2VtYWlsJyk7XG4gICAgICBjb25zdCBuYW1lQXR0ciA9IHVzZXJSZXN1bHQuVXNlckF0dHJpYnV0ZXM/LmZpbmQoKGE6IEF0dHJpYnV0ZVR5cGUpID0+IGEuTmFtZSA9PT0gJ25hbWUnKTtcbiAgICAgIGNvbnN0IHVzZXJFbWFpbCA9IGVtYWlsQXR0cj8uVmFsdWUgfHwgJyc7XG4gICAgICBjb25zdCB1c2VyTmFtZSA9IG5hbWVBdHRyPy5WYWx1ZTtcblxuICAgICAgaWYgKCF1c2VyRW1haWwpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVXNlciBlbWFpbCBub3QgZm91bmQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBHZXQgY3VycmVudGx5IGFzc2lnbmVkIGRldmljZVxuICAgICAgY29uc3QgY3VycmVudERldmljZXMgPSBhd2FpdCBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIodXNlckVtYWlsKTtcblxuICAgICAgLy8gVW5hc3NpZ24gY3VycmVudCBkZXZpY2UgaWYgYW55XG4gICAgICBpZiAoY3VycmVudERldmljZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBhd2FpdCB1bmFzc2lnbkRldmljZXNGcm9tVXNlcihjdXJyZW50RGV2aWNlcyk7XG4gICAgICB9XG5cbiAgICAgIC8vIEFzc2lnbiBuZXcgZGV2aWNlIGlmIHByb3ZpZGVkXG4gICAgICBpZiAoYm9keS5kZXZpY2VfdWlkKSB7XG4gICAgICAgIGF3YWl0IGFzc2lnbkRldmljZVRvVXNlcihib2R5LmRldmljZV91aWQsIHVzZXJFbWFpbCwgdXNlck5hbWUpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGF0dXNDb2RlOiAyMDAsXG4gICAgICAgIGhlYWRlcnMsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB1c2VybmFtZTogdXNlcklkLFxuICAgICAgICAgIGVtYWlsOiB1c2VyRW1haWwsXG4gICAgICAgICAgYXNzaWduZWRfZGV2aWNlOiBib2R5LmRldmljZV91aWQgfHwgbnVsbCxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIEdFVCAvdjEvZGV2aWNlcy91bmFzc2lnbmVkIC0gR2V0IGRldmljZXMgbm90IGFzc2lnbmVkIHRvIGFueSB1c2VyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgcGF0aCA9PT0gJy92MS9kZXZpY2VzL3VuYXNzaWduZWQnKSB7XG4gICAgICBjb25zdCBkZXZpY2VzID0gYXdhaXQgZ2V0VW5hc3NpZ25lZERldmljZXMoKTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGRldmljZXMgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIC8vIERFTEVURSAvdjEvdXNlcnMve3VzZXJJZH0gLSBEZWxldGUgYSB1c2VyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0RFTEVURScgJiYgcGF0aC5tYXRjaCgvXlxcL3YxXFwvdXNlcnNcXC9bXi9dKyQvKSkge1xuICAgICAgY29uc3QgdXNlcklkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnVzZXJJZDtcbiAgICAgIGlmICghdXNlcklkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1VzZXIgSUQgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBHZXQgdXNlcidzIGVtYWlsIHRvIHVuYXNzaWduIGRldmljZXNcbiAgICAgIGNvbnN0IHVzZXJSZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IEFkbWluR2V0VXNlckNvbW1hbmQoe1xuICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgIFVzZXJuYW1lOiB1c2VySWQsXG4gICAgICB9KSk7XG4gICAgICBjb25zdCBlbWFpbEF0dHIgPSB1c2VyUmVzdWx0LlVzZXJBdHRyaWJ1dGVzPy5maW5kKChhOiBBdHRyaWJ1dGVUeXBlKSA9PiBhLk5hbWUgPT09ICdlbWFpbCcpO1xuICAgICAgY29uc3QgdXNlckVtYWlsID0gZW1haWxBdHRyPy5WYWx1ZSB8fCAnJztcblxuICAgICAgLy8gVW5hc3NpZ24gYW55IGRldmljZXMgYXNzaWduZWQgdG8gdGhpcyB1c2VyXG4gICAgICBpZiAodXNlckVtYWlsKSB7XG4gICAgICAgIGNvbnN0IGFzc2lnbmVkRGV2aWNlcyA9IGF3YWl0IGdldERldmljZXNBc3NpZ25lZFRvVXNlcih1c2VyRW1haWwpO1xuICAgICAgICBpZiAoYXNzaWduZWREZXZpY2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBhd2FpdCB1bmFzc2lnbkRldmljZXNGcm9tVXNlcihhc3NpZ25lZERldmljZXMpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIERlbGV0ZSB0aGUgdXNlciBmcm9tIENvZ25pdG9cbiAgICAgIGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgQWRtaW5EZWxldGVVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgbWVzc2FnZTogJ1VzZXIgZGVsZXRlZCBzdWNjZXNzZnVsbHknLFxuICAgICAgICAgIHVzZXJuYW1lOiB1c2VySWQsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdOb3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ0ludGVybmFsIHNlcnZlciBlcnJvcic7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlcnJvck1lc3NhZ2UgfSksXG4gICAgfTtcbiAgfVxufVxuIl19