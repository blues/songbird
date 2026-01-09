"use strict";
/**
 * Auth Construct
 *
 * Defines Cognito User Pool for dashboard authentication.
 * Supports self-registration with automatic Viewer role assignment.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostConfirmationTrigger = exports.AuthConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaNodejs = __importStar(require("aws-cdk-lib/aws-lambda-nodejs"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const constructs_1 = require("constructs");
const path = __importStar(require("path"));
class AuthConstruct extends constructs_1.Construct {
    userPool;
    userPoolClient;
    constructor(scope, id, props) {
        super(scope, id);
        // ==========================================================================
        // Cognito User Pool
        // ==========================================================================
        this.userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: props.userPoolName,
            // Sign-in options
            signInAliases: {
                email: true,
                username: false,
            },
            // Self sign-up enabled - users get Viewer role by default via Lambda trigger
            selfSignUpEnabled: true,
            userVerification: {
                emailSubject: 'Welcome to Songbird - Verify your email',
                emailBody: 'Thanks for signing up to Songbird! Your verification code is {####}',
                emailStyle: cognito.VerificationEmailStyle.CODE,
            },
            // Password policy
            passwordPolicy: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireDigits: true,
                requireSymbols: false,
                tempPasswordValidity: cdk.Duration.days(7),
            },
            // Account recovery
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            // MFA - optional for demo
            mfa: cognito.Mfa.OPTIONAL,
            mfaSecondFactor: {
                sms: false,
                otp: true,
            },
            // User verification
            autoVerify: {
                email: true,
            },
            // Standard attributes
            standardAttributes: {
                email: {
                    required: true,
                    mutable: true,
                },
                fullname: {
                    required: true,
                    mutable: true,
                },
            },
            // Custom attributes
            customAttributes: {
                team: new cognito.StringAttribute({ mutable: true }),
                role: new cognito.StringAttribute({ mutable: true }),
                // Display preferences
                temp_unit: new cognito.StringAttribute({ mutable: true }), // 'celsius' | 'fahrenheit'
                time_format: new cognito.StringAttribute({ mutable: true }), // '12h' | '24h'
                default_time_range: new cognito.StringAttribute({ mutable: true }), // '1' | '12' | '24' | '48' | '168'
                map_style: new cognito.StringAttribute({ mutable: true }), // 'street' | 'satellite'
                distance_unit: new cognito.StringAttribute({ mutable: true }), // 'km' | 'mi'
            },
            // Email configuration (use Cognito default for demo)
            email: cognito.UserPoolEmail.withCognito(),
            // Removal policy for demo environment
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // ==========================================================================
        // User Pool Client (for Dashboard SPA)
        // ==========================================================================
        this.userPoolClient = this.userPool.addClient('DashboardClient', {
            userPoolClientName: 'songbird-dashboard',
            // Auth flows
            authFlows: {
                userPassword: true,
                userSrp: true,
            },
            // No client secret for SPA
            generateSecret: false,
            // Token validity
            accessTokenValidity: cdk.Duration.hours(1),
            idTokenValidity: cdk.Duration.hours(1),
            refreshTokenValidity: cdk.Duration.days(30),
            // Prevent user existence errors (security)
            preventUserExistenceErrors: true,
            // OAuth settings (for hosted UI if needed)
            oAuth: {
                flows: {
                    authorizationCodeGrant: true,
                    implicitCodeGrant: false,
                },
                scopes: [
                    cognito.OAuthScope.EMAIL,
                    cognito.OAuthScope.OPENID,
                    cognito.OAuthScope.PROFILE,
                ],
                callbackUrls: [
                    'http://localhost:5173/callback', // Vite dev server
                    'http://localhost:3000/callback',
                ],
                logoutUrls: [
                    'http://localhost:5173/',
                    'http://localhost:3000/',
                ],
            },
        });
        // ==========================================================================
        // User Pool Groups
        // ==========================================================================
        // Admin group - full access
        new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
            userPoolId: this.userPool.userPoolId,
            groupName: 'Admin',
            description: 'Administrators with full access',
            precedence: 1,
        });
        // Sales group
        new cognito.CfnUserPoolGroup(this, 'SalesGroup', {
            userPoolId: this.userPool.userPoolId,
            groupName: 'Sales',
            description: 'Sales team members',
            precedence: 10,
        });
        // Field Engineering group
        new cognito.CfnUserPoolGroup(this, 'FieldEngineeringGroup', {
            userPoolId: this.userPool.userPoolId,
            groupName: 'FieldEngineering',
            description: 'Field Engineering team members',
            precedence: 10,
        });
        // Read-only group
        new cognito.CfnUserPoolGroup(this, 'ViewerGroup', {
            userPoolId: this.userPool.userPoolId,
            groupName: 'Viewer',
            description: 'Read-only access',
            precedence: 100,
        });
    }
}
exports.AuthConstruct = AuthConstruct;
class PostConfirmationTrigger extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const postConfirmationLambda = new lambdaNodejs.NodejsFunction(this, 'Function', {
            functionName: 'songbird-cognito-post-confirmation',
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'handler',
            entry: path.join(__dirname, '../lambda/cognito-post-confirmation/index.ts'),
            timeout: cdk.Duration.seconds(10),
            memorySize: 128,
            bundling: {
                minify: true,
                sourceMap: false,
                externalModules: ['@aws-sdk/*'],
            },
        });
        // Grant the Lambda permission to add users to groups
        // Use wildcard to avoid circular dependency (the lambda only operates on this user pool anyway)
        postConfirmationLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['cognito-idp:AdminAddUserToGroup'],
            resources: ['*'],
        }));
        // Grant Cognito permission to invoke the Lambda using CfnPermission to avoid dependency
        new lambda.CfnPermission(this, 'CognitoInvoke', {
            action: 'lambda:InvokeFunction',
            functionName: postConfirmationLambda.functionName,
            principal: 'cognito-idp.amazonaws.com',
            sourceArn: props.userPool.userPoolArn,
        });
        // Add the Lambda trigger using escape hatch to avoid circular dependency
        const cfnUserPool = props.userPool.node.defaultChild;
        cfnUserPool.lambdaConfig = {
            postConfirmation: postConfirmationLambda.functionArn,
        };
    }
}
exports.PostConfirmationTrigger = PostConfirmationTrigger;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0aC1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYXV0aC1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUVILGlEQUFtQztBQUNuQyxpRUFBbUQ7QUFDbkQsK0RBQWlEO0FBQ2pELDRFQUE4RDtBQUM5RCx5REFBMkM7QUFDM0MsMkNBQXVDO0FBQ3ZDLDJDQUE2QjtBQU03QixNQUFhLGFBQWMsU0FBUSxzQkFBUztJQUMxQixRQUFRLENBQW1CO0lBQzNCLGNBQWMsQ0FBeUI7SUFFdkQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF5QjtRQUNqRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLDZFQUE2RTtRQUM3RSxvQkFBb0I7UUFDcEIsNkVBQTZFO1FBQzdFLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDckQsWUFBWSxFQUFFLEtBQUssQ0FBQyxZQUFZO1lBRWhDLGtCQUFrQjtZQUNsQixhQUFhLEVBQUU7Z0JBQ2IsS0FBSyxFQUFFLElBQUk7Z0JBQ1gsUUFBUSxFQUFFLEtBQUs7YUFDaEI7WUFFRCw2RUFBNkU7WUFDN0UsaUJBQWlCLEVBQUUsSUFBSTtZQUN2QixnQkFBZ0IsRUFBRTtnQkFDaEIsWUFBWSxFQUFFLHlDQUF5QztnQkFDdkQsU0FBUyxFQUFFLHFFQUFxRTtnQkFDaEYsVUFBVSxFQUFFLE9BQU8sQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJO2FBQ2hEO1lBRUQsa0JBQWtCO1lBQ2xCLGNBQWMsRUFBRTtnQkFDZCxTQUFTLEVBQUUsQ0FBQztnQkFDWixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixhQUFhLEVBQUUsSUFBSTtnQkFDbkIsY0FBYyxFQUFFLEtBQUs7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QVk7WUFDakQsU0FBUyxFQUFFLDJCQUEyQjtZQUN0QyxTQUFTLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxXQUFXO1NBQ3RDLENBQUMsQ0FBQztRQUVILHlFQUF5RTtRQUN6RSxNQUFNLFdBQVcsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxZQUFtQyxDQUFDO1FBQzVFLFdBQVcsQ0FBQyxZQUFZLEdBQUc7WUFDekIsZ0JBQWdCLEVBQUUsc0JBQXNCLENBQUMsV0FBVztTQUNyRCxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBdkNELDBEQXVDQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQXV0aCBDb25zdHJ1Y3RcbiAqXG4gKiBEZWZpbmVzIENvZ25pdG8gVXNlciBQb29sIGZvciBkYXNoYm9hcmQgYXV0aGVudGljYXRpb24uXG4gKiBTdXBwb3J0cyBzZWxmLXJlZ2lzdHJhdGlvbiB3aXRoIGF1dG9tYXRpYyBWaWV3ZXIgcm9sZSBhc3NpZ25tZW50LlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBjb2duaXRvIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcbmltcG9ydCAqIGFzIGxhbWJkYU5vZGVqcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhLW5vZGVqcyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXV0aENvbnN0cnVjdFByb3BzIHtcbiAgdXNlclBvb2xOYW1lOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBdXRoQ29uc3RydWN0IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sOiBjb2duaXRvLlVzZXJQb29sO1xuICBwdWJsaWMgcmVhZG9ubHkgdXNlclBvb2xDbGllbnQ6IGNvZ25pdG8uVXNlclBvb2xDbGllbnQ7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEF1dGhDb25zdHJ1Y3RQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIENvZ25pdG8gVXNlciBQb29sXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnVzZXJQb29sID0gbmV3IGNvZ25pdG8uVXNlclBvb2wodGhpcywgJ1VzZXJQb29sJywge1xuICAgICAgdXNlclBvb2xOYW1lOiBwcm9wcy51c2VyUG9vbE5hbWUsXG5cbiAgICAgIC8vIFNpZ24taW4gb3B0aW9uc1xuICAgICAgc2lnbkluQWxpYXNlczoge1xuICAgICAgICBlbWFpbDogdHJ1ZSxcbiAgICAgICAgdXNlcm5hbWU6IGZhbHNlLFxuICAgICAgfSxcblxuICAgICAgLy8gU2VsZiBzaWduLXVwIGVuYWJsZWQgLSB1c2VycyBnZXQgVmlld2VyIHJvbGUgYnkgZGVmYXVsdCB2aWEgTGFtYmRhIHRyaWdnZXJcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiB0cnVlLFxuICAgICAgdXNlclZlcmlmaWNhdGlvbjoge1xuICAgICAgICBlbWFpbFN1YmplY3Q6ICdXZWxjb21lIHRvIFNvbmdiaXJkIC0gVmVyaWZ5IHlvdXIgZW1haWwnLFxuICAgICAgICBlbWFpbEJvZHk6ICdUaGFua3MgZm9yIHNpZ25pbmcgdXAgdG8gU29uZ2JpcmQhIFlvdXIgdmVyaWZpY2F0aW9uIGNvZGUgaXMgeyMjIyN9JyxcbiAgICAgICAgZW1haWxTdHlsZTogY29nbml0by5WZXJpZmljYXRpb25FbWFpbFN0eWxlLkNPREUsXG4gICAgICB9LFxuXG4gICAgICAvLyBQYXNzd29yZCBwb2xpY3lcbiAgICAgIHBhc3N3b3JkUG9saWN5OiB7XG4gICAgICAgIG1pbkxlbmd0aDogOCxcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVVwcGVyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZURpZ2l0czogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IGZhbHNlLFxuICAgICAgICB0ZW1wUGFzc3dvcmRWYWxpZGl0eTogY2RrLkR1cmF0aW9uLmRheXMoNyksXG4gICAgICB9LFxuXG4gICAgICAvLyBBY2NvdW50IHJlY292ZXJ5XG4gICAgICBhY2NvdW50UmVjb3Zlcnk6IGNvZ25pdG8uQWNjb3VudFJlY292ZXJ5LkVNQUlMX09OTFksXG5cbiAgICAgIC8vIE1GQSAtIG9wdGlvbmFsIGZvciBkZW1vXG4gICAgICBtZmE6IGNvZ25pdG8uTWZhLk9QVElPTkFMLFxuICAgICAgbWZhU2Vjb25kRmFjdG9yOiB7XG4gICAgICAgIHNtczogZmFsc2UsXG4gICAgICAgIG90cDogdHJ1ZSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIFVzZXIgdmVyaWZpY2F0aW9uXG4gICAgICBhdXRvVmVyaWZ5OiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgfSxcblxuICAgICAgLy8gU3RhbmRhcmQgYXR0cmlidXRlc1xuICAgICAgc3RhbmRhcmRBdHRyaWJ1dGVzOiB7XG4gICAgICAgIGVtYWlsOiB7XG4gICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgICAgbXV0YWJsZTogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAgZnVsbG5hbWU6IHtcbiAgICAgICAgICByZXF1aXJlZDogdHJ1ZSxcbiAgICAgICAgICBtdXRhYmxlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgfSxcblxuICAgICAgLy8gQ3VzdG9tIGF0dHJpYnV0ZXNcbiAgICAgIGN1c3RvbUF0dHJpYnV0ZXM6IHtcbiAgICAgICAgdGVhbTogbmV3IGNvZ25pdG8uU3RyaW5nQXR0cmlidXRlKHsgbXV0YWJsZTogdHJ1ZSB9KSxcbiAgICAgICAgcm9sZTogbmV3IGNvZ25pdG8uU3RyaW5nQXR0cmlidXRlKHsgbXV0YWJsZTogdHJ1ZSB9KSxcbiAgICAgICAgLy8gRGlzcGxheSBwcmVmZXJlbmNlc1xuICAgICAgICB0ZW1wX3VuaXQ6IG5ldyBjb2duaXRvLlN0cmluZ0F0dHJpYnV0ZSh7IG11dGFibGU6IHRydWUgfSksIC8vICdjZWxzaXVzJyB8ICdmYWhyZW5oZWl0J1xuICAgICAgICB0aW1lX2Zvcm1hdDogbmV3IGNvZ25pdG8uU3RyaW5nQXR0cmlidXRlKHsgbXV0YWJsZTogdHJ1ZSB9KSwgLy8gJzEyaCcgfCAnMjRoJ1xuICAgICAgICBkZWZhdWx0X3RpbWVfcmFuZ2U6IG5ldyBjb2duaXRvLlN0cmluZ0F0dHJpYnV0ZSh7IG11dGFibGU6IHRydWUgfSksIC8vICcxJyB8ICcxMicgfCAnMjQnIHwgJzQ4JyB8ICcxNjgnXG4gICAgICAgIG1hcF9zdHlsZTogbmV3IGNvZ25pdG8uU3RyaW5nQXR0cmlidXRlKHsgbXV0YWJsZTogdHJ1ZSB9KSwgLy8gJ3N0cmVldCcgfCAnc2F0ZWxsaXRlJ1xuICAgICAgICBkaXN0YW5jZV91bml0OiBuZXcgY29nbml0by5TdHJpbmdBdHRyaWJ1dGUoeyBtdXRhYmxlOiB0cnVlIH0pLCAvLyAna20nIHwgJ21pJ1xuICAgICAgfSxcblxuICAgICAgLy8gRW1haWwgY29uZmlndXJhdGlvbiAodXNlIENvZ25pdG8gZGVmYXVsdCBmb3IgZGVtbylcbiAgICAgIGVtYWlsOiBjb2duaXRvLlVzZXJQb29sRW1haWwud2l0aENvZ25pdG8oKSxcblxuICAgICAgLy8gUmVtb3ZhbCBwb2xpY3kgZm9yIGRlbW8gZW52aXJvbm1lbnRcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFVzZXIgUG9vbCBDbGllbnQgKGZvciBEYXNoYm9hcmQgU1BBKVxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy51c2VyUG9vbENsaWVudCA9IHRoaXMudXNlclBvb2wuYWRkQ2xpZW50KCdEYXNoYm9hcmRDbGllbnQnLCB7XG4gICAgICB1c2VyUG9vbENsaWVudE5hbWU6ICdzb25nYmlyZC1kYXNoYm9hcmQnLFxuXG4gICAgICAvLyBBdXRoIGZsb3dzXG4gICAgICBhdXRoRmxvd3M6IHtcbiAgICAgICAgdXNlclBhc3N3b3JkOiB0cnVlLFxuICAgICAgICB1c2VyU3JwOiB0cnVlLFxuICAgICAgfSxcblxuICAgICAgLy8gTm8gY2xpZW50IHNlY3JldCBmb3IgU1BBXG4gICAgICBnZW5lcmF0ZVNlY3JldDogZmFsc2UsXG5cbiAgICAgIC8vIFRva2VuIHZhbGlkaXR5XG4gICAgICBhY2Nlc3NUb2tlblZhbGlkaXR5OiBjZGsuRHVyYXRpb24uaG91cnMoMSksXG4gICAgICBpZFRva2VuVmFsaWRpdHk6IGNkay5EdXJhdGlvbi5ob3VycygxKSxcbiAgICAgIHJlZnJlc2hUb2tlblZhbGlkaXR5OiBjZGsuRHVyYXRpb24uZGF5cygzMCksXG5cbiAgICAgIC8vIFByZXZlbnQgdXNlciBleGlzdGVuY2UgZXJyb3JzIChzZWN1cml0eSlcbiAgICAgIHByZXZlbnRVc2VyRXhpc3RlbmNlRXJyb3JzOiB0cnVlLFxuXG4gICAgICAvLyBPQXV0aCBzZXR0aW5ncyAoZm9yIGhvc3RlZCBVSSBpZiBuZWVkZWQpXG4gICAgICBvQXV0aDoge1xuICAgICAgICBmbG93czoge1xuICAgICAgICAgIGF1dGhvcml6YXRpb25Db2RlR3JhbnQ6IHRydWUsXG4gICAgICAgICAgaW1wbGljaXRDb2RlR3JhbnQ6IGZhbHNlLFxuICAgICAgICB9LFxuICAgICAgICBzY29wZXM6IFtcbiAgICAgICAgICBjb2duaXRvLk9BdXRoU2NvcGUuRU1BSUwsXG4gICAgICAgICAgY29nbml0by5PQXV0aFNjb3BlLk9QRU5JRCxcbiAgICAgICAgICBjb2duaXRvLk9BdXRoU2NvcGUuUFJPRklMRSxcbiAgICAgICAgXSxcbiAgICAgICAgY2FsbGJhY2tVcmxzOiBbXG4gICAgICAgICAgJ2h0dHA6Ly9sb2NhbGhvc3Q6NTE3My9jYWxsYmFjaycsICAvLyBWaXRlIGRldiBzZXJ2ZXJcbiAgICAgICAgICAnaHR0cDovL2xvY2FsaG9zdDozMDAwL2NhbGxiYWNrJyxcbiAgICAgICAgXSxcbiAgICAgICAgbG9nb3V0VXJsczogW1xuICAgICAgICAgICdodHRwOi8vbG9jYWxob3N0OjUxNzMvJyxcbiAgICAgICAgICAnaHR0cDovL2xvY2FsaG9zdDozMDAwLycsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBVc2VyIFBvb2wgR3JvdXBzXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuICAgIC8vIEFkbWluIGdyb3VwIC0gZnVsbCBhY2Nlc3NcbiAgICBuZXcgY29nbml0by5DZm5Vc2VyUG9vbEdyb3VwKHRoaXMsICdBZG1pbkdyb3VwJywge1xuICAgICAgdXNlclBvb2xJZDogdGhpcy51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZ3JvdXBOYW1lOiAnQWRtaW4nLFxuICAgICAgZGVzY3JpcHRpb246ICdBZG1pbmlzdHJhdG9ycyB3aXRoIGZ1bGwgYWNjZXNzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEsXG4gICAgfSk7XG5cbiAgICAvLyBTYWxlcyBncm91cFxuICAgIG5ldyBjb2duaXRvLkNmblVzZXJQb29sR3JvdXAodGhpcywgJ1NhbGVzR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdTYWxlcycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NhbGVzIHRlYW0gbWVtYmVycycsXG4gICAgICBwcmVjZWRlbmNlOiAxMCxcbiAgICB9KTtcblxuICAgIC8vIEZpZWxkIEVuZ2luZWVyaW5nIGdyb3VwXG4gICAgbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnRmllbGRFbmdpbmVlcmluZ0dyb3VwJywge1xuICAgICAgdXNlclBvb2xJZDogdGhpcy51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZ3JvdXBOYW1lOiAnRmllbGRFbmdpbmVlcmluZycsXG4gICAgICBkZXNjcmlwdGlvbjogJ0ZpZWxkIEVuZ2luZWVyaW5nIHRlYW0gbWVtYmVycycsXG4gICAgICBwcmVjZWRlbmNlOiAxMCxcbiAgICB9KTtcblxuICAgIC8vIFJlYWQtb25seSBncm91cFxuICAgIG5ldyBjb2duaXRvLkNmblVzZXJQb29sR3JvdXAodGhpcywgJ1ZpZXdlckdyb3VwJywge1xuICAgICAgdXNlclBvb2xJZDogdGhpcy51c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgZ3JvdXBOYW1lOiAnVmlld2VyJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnUmVhZC1vbmx5IGFjY2VzcycsXG4gICAgICBwcmVjZWRlbmNlOiAxMDAsXG4gICAgfSk7XG5cbiAgfVxufVxuXG4vKipcbiAqIFNlcGFyYXRlIGNvbnN0cnVjdCBmb3IgdGhlIHBvc3QtY29uZmlybWF0aW9uIExhbWJkYSB0cmlnZ2VyLlxuICogVXNlcyBhIHdpbGRjYXJkIEFSTiBmb3IgSUFNIHBlcm1pc3Npb25zIHRvIGF2b2lkIGNpcmN1bGFyIGRlcGVuZGVuY2llcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlclByb3BzIHtcbiAgdXNlclBvb2w6IGNvZ25pdG8uVXNlclBvb2w7XG59XG5cbmV4cG9ydCBjbGFzcyBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBQb3N0Q29uZmlybWF0aW9uVHJpZ2dlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHBvc3RDb25maXJtYXRpb25MYW1iZGEgPSBuZXcgbGFtYmRhTm9kZWpzLk5vZGVqc0Z1bmN0aW9uKHRoaXMsICdGdW5jdGlvbicsIHtcbiAgICAgIGZ1bmN0aW9uTmFtZTogJ3NvbmdiaXJkLWNvZ25pdG8tcG9zdC1jb25maXJtYXRpb24nLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzIwX1gsXG4gICAgICBoYW5kbGVyOiAnaGFuZGxlcicsXG4gICAgICBlbnRyeTogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uL2xhbWJkYS9jb2duaXRvLXBvc3QtY29uZmlybWF0aW9uL2luZGV4LnRzJyksXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICBtZW1vcnlTaXplOiAxMjgsXG4gICAgICBidW5kbGluZzoge1xuICAgICAgICBtaW5pZnk6IHRydWUsXG4gICAgICAgIHNvdXJjZU1hcDogZmFsc2UsXG4gICAgICAgIGV4dGVybmFsTW9kdWxlczogWydAYXdzLXNkay8qJ10sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gR3JhbnQgdGhlIExhbWJkYSBwZXJtaXNzaW9uIHRvIGFkZCB1c2VycyB0byBncm91cHNcbiAgICAvLyBVc2Ugd2lsZGNhcmQgdG8gYXZvaWQgY2lyY3VsYXIgZGVwZW5kZW5jeSAodGhlIGxhbWJkYSBvbmx5IG9wZXJhdGVzIG9uIHRoaXMgdXNlciBwb29sIGFueXdheSlcbiAgICBwb3N0Q29uZmlybWF0aW9uTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBhY3Rpb25zOiBbJ2NvZ25pdG8taWRwOkFkbWluQWRkVXNlclRvR3JvdXAnXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgfSkpO1xuXG4gICAgLy8gR3JhbnQgQ29nbml0byBwZXJtaXNzaW9uIHRvIGludm9rZSB0aGUgTGFtYmRhIHVzaW5nIENmblBlcm1pc3Npb24gdG8gYXZvaWQgZGVwZW5kZW5jeVxuICAgIG5ldyBsYW1iZGEuQ2ZuUGVybWlzc2lvbih0aGlzLCAnQ29nbml0b0ludm9rZScsIHtcbiAgICAgIGFjdGlvbjogJ2xhbWJkYTpJbnZva2VGdW5jdGlvbicsXG4gICAgICBmdW5jdGlvbk5hbWU6IHBvc3RDb25maXJtYXRpb25MYW1iZGEuZnVuY3Rpb25OYW1lLFxuICAgICAgcHJpbmNpcGFsOiAnY29nbml0by1pZHAuYW1hem9uYXdzLmNvbScsXG4gICAgICBzb3VyY2VBcm46IHByb3BzLnVzZXJQb29sLnVzZXJQb29sQXJuLFxuICAgIH0pO1xuXG4gICAgLy8gQWRkIHRoZSBMYW1iZGEgdHJpZ2dlciB1c2luZyBlc2NhcGUgaGF0Y2ggdG8gYXZvaWQgY2lyY3VsYXIgZGVwZW5kZW5jeVxuICAgIGNvbnN0IGNmblVzZXJQb29sID0gcHJvcHMudXNlclBvb2wubm9kZS5kZWZhdWx0Q2hpbGQgYXMgY29nbml0by5DZm5Vc2VyUG9vbDtcbiAgICBjZm5Vc2VyUG9vbC5sYW1iZGFDb25maWcgPSB7XG4gICAgICBwb3N0Q29uZmlybWF0aW9uOiBwb3N0Q29uZmlybWF0aW9uTGFtYmRhLmZ1bmN0aW9uQXJuLFxuICAgIH07XG4gIH1cbn1cbiJdfQ==