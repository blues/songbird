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
        const emailAttr = user.Attributes?.find(a => a.Name === 'email');
        const nameAttr = user.Attributes?.find(a => a.Name === 'name');
        // Get groups for this user
        const groupsResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminListGroupsForUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: user.Username,
        }));
        const groups = (groupsResult.Groups || []).map(g => g.GroupName);
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
    return (result.Items || []).map(item => item.device_uid);
}
async function assignDeviceToUser(deviceUid, userEmail) {
    // First, unassign any device currently assigned to this user (single device per user)
    const currentDevices = await getDevicesAssignedToUser(userEmail);
    if (currentDevices.length > 0) {
        await unassignDevicesFromUser(currentDevices);
    }
    // Now assign the new device
    await docClient.send(new lib_dynamodb_1.UpdateCommand({
        TableName: DEVICES_TABLE,
        Key: { device_uid: deviceUid },
        UpdateExpression: 'SET assigned_to = :email, updated_at = :now',
        ExpressionAttributeValues: {
            ':email': userEmail,
            ':now': Date.now(),
        },
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
    return (result.Items || []).map(item => ({
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
            UpdateExpression: 'REMOVE assigned_to SET updated_at = :now',
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
            const groups = (result.Groups || []).map(g => ({
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
            const emailAttr = userResult.UserAttributes?.find(a => a.Name === 'email');
            const nameAttr = userResult.UserAttributes?.find(a => a.Name === 'name');
            const groups = (groupsResult.Groups || []).map(g => g.GroupName);
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
                await assignDeviceToUser(body.device_uids[0], body.email);
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
            const currentGroups = (currentGroupsResult.Groups || []).map(g => g.GroupName);
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
            // Get user's email
            const userResult = await cognitoClient.send(new client_cognito_identity_provider_1.AdminGetUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: userId,
            }));
            const emailAttr = userResult.UserAttributes?.find(a => a.Name === 'email');
            const userEmail = emailAttr?.Value || '';
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
                await assignDeviceToUser(body.device_uid, userEmail);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9sYW1iZGEvYXBpLXVzZXJzL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7O0FBRUgsZ0dBVW1EO0FBQ25ELDhEQUEwRDtBQUMxRCx3REFBMkY7QUFHM0YsTUFBTSxhQUFhLEdBQUcsSUFBSSxnRUFBNkIsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUM1RCxNQUFNLFlBQVksR0FBRyxJQUFJLGdDQUFjLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDNUMsTUFBTSxTQUFTLEdBQUcscUNBQXNCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBRTVELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxHQUFHLENBQUMsWUFBWSxJQUFJLEVBQUUsQ0FBQztBQUNwRCxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLGFBQWEsSUFBSSxrQkFBa0IsQ0FBQztBQUV0RSxNQUFNLE9BQU8sR0FBRztJQUNkLGNBQWMsRUFBRSxrQkFBa0I7SUFDbEMsNkJBQTZCLEVBQUUsR0FBRztJQUNsQyw4QkFBOEIsRUFBRSw0QkFBNEI7SUFDNUQsOEJBQThCLEVBQUUsNkJBQTZCO0NBQzlELENBQUM7QUFFRixNQUFNLFlBQVksR0FBRyxDQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFFdEUsU0FBUyxPQUFPLENBQUMsS0FBNkI7SUFDNUMsSUFBSSxDQUFDO1FBQ0gsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLGNBQWMsRUFBRSxVQUFVLEVBQUUsR0FBRyxFQUFFLE1BQU0sQ0FBQztRQUM3RCxJQUFJLENBQUMsTUFBTTtZQUFFLE9BQU8sS0FBSyxDQUFDO1FBRTFCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3hDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENB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QUM7UUFDdEYsT0FBTztZQUNMLFVBQVUsRUFBRSxHQUFHO1lBQ2YsT0FBTztZQUNQLElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsS0FBSyxFQUFFLFlBQVksRUFBRSxDQUFDO1NBQzlDLENBQUM7SUFDSixDQUFDO0FBQ0gsQ0FBQztBQXZWRCwwQkF1VkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFQSSBVc2VycyBMYW1iZGFcbiAqXG4gKiBIYW5kbGVzIHVzZXIgbWFuYWdlbWVudCBvcGVyYXRpb25zIHVzaW5nIENvZ25pdG8gQWRtaW4gQVBJcy5cbiAqIEFsbCBlbmRwb2ludHMgYXJlIGFkbWluLW9ubHkuXG4gKi9cblxuaW1wb3J0IHtcbiAgQ29nbml0b0lkZW50aXR5UHJvdmlkZXJDbGllbnQsXG4gIExpc3RVc2Vyc0NvbW1hbmQsXG4gIEFkbWluQ3JlYXRlVXNlckNvbW1hbmQsXG4gIEFkbWluQWRkVXNlclRvR3JvdXBDb21tYW5kLFxuICBBZG1pblJlbW92ZVVzZXJGcm9tR3JvdXBDb21tYW5kLFxuICBBZG1pbkxpc3RHcm91cHNGb3JVc2VyQ29tbWFuZCxcbiAgQWRtaW5HZXRVc2VyQ29tbWFuZCxcbiAgQWRtaW5VcGRhdGVVc2VyQXR0cmlidXRlc0NvbW1hbmQsXG4gIExpc3RHcm91cHNDb21tYW5kLFxufSBmcm9tICdAYXdzLXNkay9jbGllbnQtY29nbml0by1pZGVudGl0eS1wcm92aWRlcic7XG5pbXBvcnQgeyBEeW5hbW9EQkNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1keW5hbW9kYic7XG5pbXBvcnQgeyBEeW5hbW9EQkRvY3VtZW50Q2xpZW50LCBVcGRhdGVDb21tYW5kLCBTY2FuQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2xpYi1keW5hbW9kYic7XG5pbXBvcnQgdHlwZSB7IEFQSUdhdGV3YXlQcm94eUV2ZW50VjIsIEFQSUdhdGV3YXlQcm94eVJlc3VsdFYyIH0gZnJvbSAnYXdzLWxhbWJkYSc7XG5cbmNvbnN0IGNvZ25pdG9DbGllbnQgPSBuZXcgQ29nbml0b0lkZW50aXR5UHJvdmlkZXJDbGllbnQoe30pO1xuY29uc3QgZHluYW1vQ2xpZW50ID0gbmV3IER5bmFtb0RCQ2xpZW50KHt9KTtcbmNvbnN0IGRvY0NsaWVudCA9IER5bmFtb0RCRG9jdW1lbnRDbGllbnQuZnJvbShkeW5hbW9DbGllbnQpO1xuXG5jb25zdCBVU0VSX1BPT0xfSUQgPSBwcm9jZXNzLmVudi5VU0VSX1BPT0xfSUQgfHwgJyc7XG5jb25zdCBERVZJQ0VTX1RBQkxFID0gcHJvY2Vzcy5lbnYuREVWSUNFU19UQUJMRSB8fCAnc29uZ2JpcmQtZGV2aWNlcyc7XG5cbmNvbnN0IGhlYWRlcnMgPSB7XG4gICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nOiAnKicsXG4gICdBY2Nlc3MtQ29udHJvbC1BbGxvdy1IZWFkZXJzJzogJ0NvbnRlbnQtVHlwZSxBdXRob3JpemF0aW9uJyxcbiAgJ0FjY2Vzcy1Db250cm9sLUFsbG93LU1ldGhvZHMnOiAnR0VULFBPU1QsUFVULERFTEVURSxPUFRJT05TJyxcbn07XG5cbmNvbnN0IFZBTElEX0dST1VQUyA9IFsnQWRtaW4nLCAnU2FsZXMnLCAnRmllbGRFbmdpbmVlcmluZycsICdWaWV3ZXInXTtcblxuZnVuY3Rpb24gaXNBZG1pbihldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnRWMik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IGNsYWltcyA9IGV2ZW50LnJlcXVlc3RDb250ZXh0Py5hdXRob3JpemVyPy5qd3Q/LmNsYWltcztcbiAgICBpZiAoIWNsYWltcykgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgZ3JvdXBzID0gY2xhaW1zWydjb2duaXRvOmdyb3VwcyddO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwcykpIHtcbiAgICAgIHJldHVybiBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgZ3JvdXBzID09PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGdyb3VwcyA9PT0gJ0FkbWluJyB8fCBncm91cHMuaW5jbHVkZXMoJ0FkbWluJyk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmludGVyZmFjZSBVc2VySW5mbyB7XG4gIHVzZXJuYW1lOiBzdHJpbmc7XG4gIGVtYWlsOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIGNyZWF0ZWRfYXQ6IHN0cmluZztcbiAgZ3JvdXBzOiBzdHJpbmdbXTtcbiAgYXNzaWduZWRfZGV2aWNlcz86IHN0cmluZ1tdO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsaXN0VXNlcnMoKTogUHJvbWlzZTxVc2VySW5mb1tdPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvZ25pdG9DbGllbnQuc2VuZChuZXcgTGlzdFVzZXJzQ29tbWFuZCh7XG4gICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgIExpbWl0OiA2MCxcbiAgfSkpO1xuXG4gIGNvbnN0IHVzZXJzOiBVc2VySW5mb1tdID0gW107XG5cbiAgZm9yIChjb25zdCB1c2VyIG9mIHJlc3VsdC5Vc2VycyB8fCBbXSkge1xuICAgIGNvbnN0IGVtYWlsQXR0ciA9IHVzZXIuQXR0cmlidXRlcz8uZmluZChhID0+IGEuTmFtZSA9PT0gJ2VtYWlsJyk7XG4gICAgY29uc3QgbmFtZUF0dHIgPSB1c2VyLkF0dHJpYnV0ZXM/LmZpbmQoYSA9PiBhLk5hbWUgPT09ICduYW1lJyk7XG5cbiAgICAvLyBHZXQgZ3JvdXBzIGZvciB0aGlzIHVzZXJcbiAgICBjb25zdCBncm91cHNSZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IEFkbWluTGlzdEdyb3Vwc0ZvclVzZXJDb21tYW5kKHtcbiAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgIFVzZXJuYW1lOiB1c2VyLlVzZXJuYW1lISxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBncm91cHMgPSAoZ3JvdXBzUmVzdWx0Lkdyb3VwcyB8fCBbXSkubWFwKGcgPT4gZy5Hcm91cE5hbWUhKTtcblxuICAgIHVzZXJzLnB1c2goe1xuICAgICAgdXNlcm5hbWU6IHVzZXIuVXNlcm5hbWUhLFxuICAgICAgZW1haWw6IGVtYWlsQXR0cj8uVmFsdWUgfHwgJycsXG4gICAgICBuYW1lOiBuYW1lQXR0cj8uVmFsdWUgfHwgJycsXG4gICAgICBzdGF0dXM6IHVzZXIuVXNlclN0YXR1cyB8fCAnVU5LTk9XTicsXG4gICAgICBjcmVhdGVkX2F0OiB1c2VyLlVzZXJDcmVhdGVEYXRlPy50b0lTT1N0cmluZygpIHx8ICcnLFxuICAgICAgZ3JvdXBzLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHVzZXJzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIodXNlckVtYWlsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEZpbHRlckV4cHJlc3Npb246ICdhc3NpZ25lZF90byA9IDplbWFpbCcsXG4gICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgJzplbWFpbCc6IHVzZXJFbWFpbCxcbiAgICB9LFxuICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCcsXG4gIH0pKTtcblxuICByZXR1cm4gKHJlc3VsdC5JdGVtcyB8fCBbXSkubWFwKGl0ZW0gPT4gaXRlbS5kZXZpY2VfdWlkKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXNzaWduRGV2aWNlVG9Vc2VyKGRldmljZVVpZDogc3RyaW5nLCB1c2VyRW1haWw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBGaXJzdCwgdW5hc3NpZ24gYW55IGRldmljZSBjdXJyZW50bHkgYXNzaWduZWQgdG8gdGhpcyB1c2VyIChzaW5nbGUgZGV2aWNlIHBlciB1c2VyKVxuICBjb25zdCBjdXJyZW50RGV2aWNlcyA9IGF3YWl0IGdldERldmljZXNBc3NpZ25lZFRvVXNlcih1c2VyRW1haWwpO1xuICBpZiAoY3VycmVudERldmljZXMubGVuZ3RoID4gMCkge1xuICAgIGF3YWl0IHVuYXNzaWduRGV2aWNlc0Zyb21Vc2VyKGN1cnJlbnREZXZpY2VzKTtcbiAgfVxuXG4gIC8vIE5vdyBhc3NpZ24gdGhlIG5ldyBkZXZpY2VcbiAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgIFRhYmxlTmFtZTogREVWSUNFU19UQUJMRSxcbiAgICBLZXk6IHsgZGV2aWNlX3VpZDogZGV2aWNlVWlkIH0sXG4gICAgVXBkYXRlRXhwcmVzc2lvbjogJ1NFVCBhc3NpZ25lZF90byA9IDplbWFpbCwgdXBkYXRlZF9hdCA9IDpub3cnLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZW1haWwnOiB1c2VyRW1haWwsXG4gICAgICAnOm5vdyc6IERhdGUubm93KCksXG4gICAgfSxcbiAgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRVbmFzc2lnbmVkRGV2aWNlcygpOiBQcm9taXNlPHsgZGV2aWNlX3VpZDogc3RyaW5nOyBzZXJpYWxfbnVtYmVyOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfVtdPiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGRvY0NsaWVudC5zZW5kKG5ldyBTY2FuQ29tbWFuZCh7XG4gICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgIEZpbHRlckV4cHJlc3Npb246ICdhdHRyaWJ1dGVfbm90X2V4aXN0cyhhc3NpZ25lZF90bykgT1IgYXNzaWduZWRfdG8gPSA6ZW1wdHknLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICc6ZW1wdHknOiAnJyxcbiAgICB9LFxuICAgIFByb2plY3Rpb25FeHByZXNzaW9uOiAnZGV2aWNlX3VpZCwgc2VyaWFsX251bWJlciwgI24nLFxuICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgJyNuJzogJ25hbWUnLFxuICAgIH0sXG4gIH0pKTtcblxuICByZXR1cm4gKHJlc3VsdC5JdGVtcyB8fCBbXSkubWFwKGl0ZW0gPT4gKHtcbiAgICBkZXZpY2VfdWlkOiBpdGVtLmRldmljZV91aWQsXG4gICAgc2VyaWFsX251bWJlcjogaXRlbS5zZXJpYWxfbnVtYmVyLFxuICAgIG5hbWU6IGl0ZW0ubmFtZSxcbiAgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiB1bmFzc2lnbkRldmljZXNGcm9tVXNlcihkZXZpY2VVaWRzOiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICBmb3IgKGNvbnN0IGRldmljZVVpZCBvZiBkZXZpY2VVaWRzKSB7XG4gICAgYXdhaXQgZG9jQ2xpZW50LnNlbmQobmV3IFVwZGF0ZUNvbW1hbmQoe1xuICAgICAgVGFibGVOYW1lOiBERVZJQ0VTX1RBQkxFLFxuICAgICAgS2V5OiB7IGRldmljZV91aWQ6IGRldmljZVVpZCB9LFxuICAgICAgVXBkYXRlRXhwcmVzc2lvbjogJ1JFTU9WRSBhc3NpZ25lZF90byBTRVQgdXBkYXRlZF9hdCA9IDpub3cnLFxuICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAnOm5vdyc6IERhdGUubm93KCksXG4gICAgICB9LFxuICAgIH0pKTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihldmVudDogQVBJR2F0ZXdheVByb3h5RXZlbnRWMik6IFByb21pc2U8QVBJR2F0ZXdheVByb3h5UmVzdWx0VjI+IHtcbiAgY29uc29sZS5sb2coJ0V2ZW50OicsIEpTT04uc3RyaW5naWZ5KGV2ZW50LCBudWxsLCAyKSk7XG5cbiAgY29uc3QgbWV0aG9kID0gZXZlbnQucmVxdWVzdENvbnRleHQuaHR0cC5tZXRob2Q7XG4gIGNvbnN0IHBhdGggPSBldmVudC5yYXdQYXRoO1xuXG4gIC8vIEhhbmRsZSBPUFRJT05TIGZvciBDT1JTXG4gIGlmIChtZXRob2QgPT09ICdPUFRJT05TJykge1xuICAgIHJldHVybiB7IHN0YXR1c0NvZGU6IDIwMCwgaGVhZGVycywgYm9keTogJycgfTtcbiAgfVxuXG4gIC8vIEFsbCB1c2VyIG1hbmFnZW1lbnQgZW5kcG9pbnRzIHJlcXVpcmUgYWRtaW5cbiAgaWYgKCFpc0FkbWluKGV2ZW50KSkge1xuICAgIHJldHVybiB7XG4gICAgICBzdGF0dXNDb2RlOiA0MDMsXG4gICAgICBoZWFkZXJzLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ0FkbWluIGFjY2VzcyByZXF1aXJlZCcgfSksXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gR0VUIC92MS91c2VycyAtIExpc3QgYWxsIHVzZXJzXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgcGF0aCA9PT0gJy92MS91c2VycycpIHtcbiAgICAgIGNvbnN0IHVzZXJzID0gYXdhaXQgbGlzdFVzZXJzKCk7XG5cbiAgICAgIC8vIE9wdGlvbmFsbHkgaW5jbHVkZSBhc3NpZ25lZCBkZXZpY2VzIGZvciBlYWNoIHVzZXJcbiAgICAgIGNvbnN0IGluY2x1ZGVEZXZpY2VzID0gZXZlbnQucXVlcnlTdHJpbmdQYXJhbWV0ZXJzPy5pbmNsdWRlX2RldmljZXMgPT09ICd0cnVlJztcbiAgICAgIGlmIChpbmNsdWRlRGV2aWNlcykge1xuICAgICAgICBmb3IgKGNvbnN0IHVzZXIgb2YgdXNlcnMpIHtcbiAgICAgICAgICB1c2VyLmFzc2lnbmVkX2RldmljZXMgPSBhd2FpdCBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIodXNlci5lbWFpbCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHVzZXJzIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL3YxL3VzZXJzL2dyb3VwcyAtIExpc3QgYXZhaWxhYmxlIGdyb3Vwc1xuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHBhdGggPT09ICcvdjEvdXNlcnMvZ3JvdXBzJykge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBMaXN0R3JvdXBzQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgZ3JvdXBzID0gKHJlc3VsdC5Hcm91cHMgfHwgW10pLm1hcChnID0+ICh7XG4gICAgICAgIG5hbWU6IGcuR3JvdXBOYW1lLFxuICAgICAgICBkZXNjcmlwdGlvbjogZy5EZXNjcmlwdGlvbixcbiAgICAgIH0pKTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGdyb3VwcyB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gR0VUIC92MS91c2Vycy97dXNlcklkfSAtIEdldCBzcGVjaWZpYyB1c2VyXG4gICAgaWYgKG1ldGhvZCA9PT0gJ0dFVCcgJiYgcGF0aC5tYXRjaCgvXlxcL3YxXFwvdXNlcnNcXC9bXi9dKyQvKSkge1xuICAgICAgY29uc3QgdXNlcklkID0gZXZlbnQucGF0aFBhcmFtZXRlcnM/LnVzZXJJZDtcbiAgICAgIGlmICghdXNlcklkKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogNDAwLFxuICAgICAgICAgIGhlYWRlcnMsXG4gICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogJ1VzZXIgSUQgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCB1c2VyUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkdldFVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgfSkpO1xuXG4gICAgICBjb25zdCBncm91cHNSZXN1bHQgPSBhd2FpdCBjb2duaXRvQ2xpZW50LnNlbmQobmV3IEFkbWluTGlzdEdyb3Vwc0ZvclVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgfSkpO1xuXG4gICAgICBjb25zdCBlbWFpbEF0dHIgPSB1c2VyUmVzdWx0LlVzZXJBdHRyaWJ1dGVzPy5maW5kKGEgPT4gYS5OYW1lID09PSAnZW1haWwnKTtcbiAgICAgIGNvbnN0IG5hbWVBdHRyID0gdXNlclJlc3VsdC5Vc2VyQXR0cmlidXRlcz8uZmluZChhID0+IGEuTmFtZSA9PT0gJ25hbWUnKTtcbiAgICAgIGNvbnN0IGdyb3VwcyA9IChncm91cHNSZXN1bHQuR3JvdXBzIHx8IFtdKS5tYXAoZyA9PiBnLkdyb3VwTmFtZSEpO1xuXG4gICAgICBjb25zdCBhc3NpZ25lZERldmljZXMgPSBhd2FpdCBnZXREZXZpY2VzQXNzaWduZWRUb1VzZXIoZW1haWxBdHRyPy5WYWx1ZSB8fCAnJyk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHVzZXJuYW1lOiB1c2VyUmVzdWx0LlVzZXJuYW1lLFxuICAgICAgICAgIGVtYWlsOiBlbWFpbEF0dHI/LlZhbHVlIHx8ICcnLFxuICAgICAgICAgIG5hbWU6IG5hbWVBdHRyPy5WYWx1ZSB8fCAnJyxcbiAgICAgICAgICBzdGF0dXM6IHVzZXJSZXN1bHQuVXNlclN0YXR1cyxcbiAgICAgICAgICBjcmVhdGVkX2F0OiB1c2VyUmVzdWx0LlVzZXJDcmVhdGVEYXRlPy50b0lTT1N0cmluZygpLFxuICAgICAgICAgIGdyb3VwcyxcbiAgICAgICAgICBhc3NpZ25lZF9kZXZpY2VzOiBhc3NpZ25lZERldmljZXMsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBQT1NUIC92MS91c2VycyAtIEludml0ZSBuZXcgdXNlclxuICAgIGlmIChtZXRob2QgPT09ICdQT1NUJyAmJiBwYXRoID09PSAnL3YxL3VzZXJzJykge1xuICAgICAgbGV0IGJvZHk6IHtcbiAgICAgICAgZW1haWw6IHN0cmluZztcbiAgICAgICAgbmFtZTogc3RyaW5nO1xuICAgICAgICBncm91cDogc3RyaW5nO1xuICAgICAgICBkZXZpY2VfdWlkcz86IHN0cmluZ1tdO1xuICAgICAgfTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYm9keSA9IEpTT04ucGFyc2UoZXZlbnQuYm9keSB8fCAne30nKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdJbnZhbGlkIEpTT04gYm9keScgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIHJlcXVpcmVkIGZpZWxkc1xuICAgICAgaWYgKCFib2R5LmVtYWlsIHx8ICFib2R5Lm5hbWUgfHwgIWJvZHkuZ3JvdXApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnZW1haWwsIG5hbWUsIGFuZCBncm91cCBhcmUgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBncm91cFxuICAgICAgaWYgKCFWQUxJRF9HUk9VUFMuaW5jbHVkZXMoYm9keS5ncm91cCkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBgZ3JvdXAgbXVzdCBiZSBvbmUgb2Y6ICR7VkFMSURfR1JPVVBTLmpvaW4oJywgJyl9YCB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgLy8gQ3JlYXRlIHVzZXIgaW4gQ29nbml0b1xuICAgICAgY29uc3QgY3JlYXRlUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkNyZWF0ZVVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogYm9keS5lbWFpbCxcbiAgICAgICAgVXNlckF0dHJpYnV0ZXM6IFtcbiAgICAgICAgICB7IE5hbWU6ICdlbWFpbCcsIFZhbHVlOiBib2R5LmVtYWlsIH0sXG4gICAgICAgICAgeyBOYW1lOiAnZW1haWxfdmVyaWZpZWQnLCBWYWx1ZTogJ3RydWUnIH0sXG4gICAgICAgICAgeyBOYW1lOiAnbmFtZScsIFZhbHVlOiBib2R5Lm5hbWUgfSxcbiAgICAgICAgXSxcbiAgICAgICAgRGVzaXJlZERlbGl2ZXJ5TWVkaXVtczogWydFTUFJTCddLFxuICAgICAgfSkpO1xuXG4gICAgICAvLyBBZGQgdXNlciB0byBncm91cFxuICAgICAgYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkFkZFVzZXJUb0dyb3VwQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IGJvZHkuZW1haWwsXG4gICAgICAgIEdyb3VwTmFtZTogYm9keS5ncm91cCxcbiAgICAgIH0pKTtcblxuICAgICAgLy8gQXNzaWduIGRldmljZSBpZiBwcm92aWRlZCAob25seSBvbmUgZGV2aWNlIHBlciB1c2VyKVxuICAgICAgaWYgKGJvZHkuZGV2aWNlX3VpZHMgJiYgYm9keS5kZXZpY2VfdWlkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIC8vIE9ubHkgYXNzaWduIHRoZSBmaXJzdCBkZXZpY2UgKHNpbmdsZSBkZXZpY2UgcGVyIHVzZXIpXG4gICAgICAgIGF3YWl0IGFzc2lnbkRldmljZVRvVXNlcihib2R5LmRldmljZV91aWRzWzBdLCBib2R5LmVtYWlsKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAxLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdXNlcm5hbWU6IGNyZWF0ZVJlc3VsdC5Vc2VyPy5Vc2VybmFtZSxcbiAgICAgICAgICBlbWFpbDogYm9keS5lbWFpbCxcbiAgICAgICAgICBuYW1lOiBib2R5Lm5hbWUsXG4gICAgICAgICAgZ3JvdXBzOiBbYm9keS5ncm91cF0sXG4gICAgICAgICAgYXNzaWduZWRfZGV2aWNlczogYm9keS5kZXZpY2VfdWlkcyB8fCBbXSxcbiAgICAgICAgICBzdGF0dXM6IGNyZWF0ZVJlc3VsdC5Vc2VyPy5Vc2VyU3RhdHVzLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUFVUIC92MS91c2Vycy97dXNlcklkfS9ncm91cHMgLSBVcGRhdGUgdXNlciBncm91cHNcbiAgICBpZiAobWV0aG9kID09PSAnUFVUJyAmJiBwYXRoLm1hdGNoKC9eXFwvdjFcXC91c2Vyc1xcL1teL10rXFwvZ3JvdXBzJC8pKSB7XG4gICAgICBjb25zdCB1c2VySWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8udXNlcklkO1xuICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVXNlciBJRCByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGxldCBib2R5OiB7IGdyb3Vwczogc3RyaW5nW10gfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkgfHwgJ3t9Jyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBKU09OIGJvZHknIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBpZiAoIWJvZHkuZ3JvdXBzIHx8ICFBcnJheS5pc0FycmF5KGJvZHkuZ3JvdXBzKSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdncm91cHMgYXJyYXkgcmVxdWlyZWQnIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBhbGwgZ3JvdXBzXG4gICAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIGJvZHkuZ3JvdXBzKSB7XG4gICAgICAgIGlmICghVkFMSURfR1JPVVBTLmluY2x1ZGVzKGdyb3VwKSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogYEludmFsaWQgZ3JvdXA6ICR7Z3JvdXB9LiBNdXN0IGJlIG9uZSBvZjogJHtWQUxJRF9HUk9VUFMuam9pbignLCAnKX1gIH0pLFxuICAgICAgICAgIH07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gR2V0IGN1cnJlbnQgZ3JvdXBzXG4gICAgICBjb25zdCBjdXJyZW50R3JvdXBzUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkxpc3RHcm91cHNGb3JVc2VyQ29tbWFuZCh7XG4gICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgVXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgIH0pKTtcbiAgICAgIGNvbnN0IGN1cnJlbnRHcm91cHMgPSAoY3VycmVudEdyb3Vwc1Jlc3VsdC5Hcm91cHMgfHwgW10pLm1hcChnID0+IGcuR3JvdXBOYW1lISk7XG5cbiAgICAgIC8vIFJlbW92ZSBmcm9tIGdyb3VwcyBubyBsb25nZXIgaW4gbGlzdFxuICAgICAgZm9yIChjb25zdCBncm91cCBvZiBjdXJyZW50R3JvdXBzKSB7XG4gICAgICAgIGlmICghYm9keS5ncm91cHMuaW5jbHVkZXMoZ3JvdXApKSB7XG4gICAgICAgICAgYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pblJlbW92ZVVzZXJGcm9tR3JvdXBDb21tYW5kKHtcbiAgICAgICAgICAgIFVzZXJQb29sSWQ6IFVTRVJfUE9PTF9JRCxcbiAgICAgICAgICAgIFVzZXJuYW1lOiB1c2VySWQsXG4gICAgICAgICAgICBHcm91cE5hbWU6IGdyb3VwLFxuICAgICAgICAgIH0pKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgdG8gbmV3IGdyb3Vwc1xuICAgICAgZm9yIChjb25zdCBncm91cCBvZiBib2R5Lmdyb3Vwcykge1xuICAgICAgICBpZiAoIWN1cnJlbnRHcm91cHMuaW5jbHVkZXMoZ3JvdXApKSB7XG4gICAgICAgICAgYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkFkZFVzZXJUb0dyb3VwQ29tbWFuZCh7XG4gICAgICAgICAgICBVc2VyUG9vbElkOiBVU0VSX1BPT0xfSUQsXG4gICAgICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgICAgICAgR3JvdXBOYW1lOiBncm91cCxcbiAgICAgICAgICB9KSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgICAgICBncm91cHM6IGJvZHkuZ3JvdXBzLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUFVUIC92MS91c2Vycy97dXNlcklkfS9kZXZpY2UgLSBVcGRhdGUgdXNlcidzIGFzc2lnbmVkIGRldmljZSAoc2luZ2xlIGRldmljZSBwZXIgdXNlcilcbiAgICBpZiAobWV0aG9kID09PSAnUFVUJyAmJiBwYXRoLm1hdGNoKC9eXFwvdjFcXC91c2Vyc1xcL1teL10rXFwvZGV2aWNlJC8pKSB7XG4gICAgICBjb25zdCB1c2VySWQgPSBldmVudC5wYXRoUGFyYW1ldGVycz8udXNlcklkO1xuICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnVXNlciBJRCByZXF1aXJlZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIGxldCBib2R5OiB7IGRldmljZV91aWQ6IHN0cmluZyB8IG51bGwgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKGV2ZW50LmJvZHkgfHwgJ3t9Jyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiA0MDAsXG4gICAgICAgICAgaGVhZGVycyxcbiAgICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiAnSW52YWxpZCBKU09OIGJvZHknIH0pLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBHZXQgdXNlcidzIGVtYWlsXG4gICAgICBjb25zdCB1c2VyUmVzdWx0ID0gYXdhaXQgY29nbml0b0NsaWVudC5zZW5kKG5ldyBBZG1pbkdldFVzZXJDb21tYW5kKHtcbiAgICAgICAgVXNlclBvb2xJZDogVVNFUl9QT09MX0lELFxuICAgICAgICBVc2VybmFtZTogdXNlcklkLFxuICAgICAgfSkpO1xuICAgICAgY29uc3QgZW1haWxBdHRyID0gdXNlclJlc3VsdC5Vc2VyQXR0cmlidXRlcz8uZmluZChhID0+IGEuTmFtZSA9PT0gJ2VtYWlsJyk7XG4gICAgICBjb25zdCB1c2VyRW1haWwgPSBlbWFpbEF0dHI/LlZhbHVlIHx8ICcnO1xuXG4gICAgICBpZiAoIXVzZXJFbWFpbCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IDQwMCxcbiAgICAgICAgICBoZWFkZXJzLFxuICAgICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdVc2VyIGVtYWlsIG5vdCBmb3VuZCcgfSksXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vIEdldCBjdXJyZW50bHkgYXNzaWduZWQgZGV2aWNlXG4gICAgICBjb25zdCBjdXJyZW50RGV2aWNlcyA9IGF3YWl0IGdldERldmljZXNBc3NpZ25lZFRvVXNlcih1c2VyRW1haWwpO1xuXG4gICAgICAvLyBVbmFzc2lnbiBjdXJyZW50IGRldmljZSBpZiBhbnlcbiAgICAgIGlmIChjdXJyZW50RGV2aWNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IHVuYXNzaWduRGV2aWNlc0Zyb21Vc2VyKGN1cnJlbnREZXZpY2VzKTtcbiAgICAgIH1cblxuICAgICAgLy8gQXNzaWduIG5ldyBkZXZpY2UgaWYgcHJvdmlkZWRcbiAgICAgIGlmIChib2R5LmRldmljZV91aWQpIHtcbiAgICAgICAgYXdhaXQgYXNzaWduRGV2aWNlVG9Vc2VyKGJvZHkuZGV2aWNlX3VpZCwgdXNlckVtYWlsKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzQ29kZTogMjAwLFxuICAgICAgICBoZWFkZXJzLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgdXNlcm5hbWU6IHVzZXJJZCxcbiAgICAgICAgICBlbWFpbDogdXNlckVtYWlsLFxuICAgICAgICAgIGFzc2lnbmVkX2RldmljZTogYm9keS5kZXZpY2VfdWlkIHx8IG51bGwsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICAvLyBHRVQgL3YxL2RldmljZXMvdW5hc3NpZ25lZCAtIEdldCBkZXZpY2VzIG5vdCBhc3NpZ25lZCB0byBhbnkgdXNlclxuICAgIGlmIChtZXRob2QgPT09ICdHRVQnICYmIHBhdGggPT09ICcvdjEvZGV2aWNlcy91bmFzc2lnbmVkJykge1xuICAgICAgY29uc3QgZGV2aWNlcyA9IGF3YWl0IGdldFVuYXNzaWduZWREZXZpY2VzKCk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN0YXR1c0NvZGU6IDIwMCxcbiAgICAgICAgaGVhZGVycyxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBkZXZpY2VzIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzQ29kZTogNDA0LFxuICAgICAgaGVhZGVycyxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6ICdOb3QgZm91bmQnIH0pLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJyb3I6JywgZXJyb3IpO1xuICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogJ0ludGVybmFsIHNlcnZlciBlcnJvcic7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c0NvZGU6IDUwMCxcbiAgICAgIGhlYWRlcnMsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlcnJvck1lc3NhZ2UgfSksXG4gICAgfTtcbiAgfVxufVxuIl19