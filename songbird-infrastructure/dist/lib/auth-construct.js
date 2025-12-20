"use strict";
/**
 * Auth Construct
 *
 * Defines Cognito User Pool for dashboard authentication.
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
exports.AuthConstruct = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const constructs_1 = require("constructs");
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
            // Self sign-up disabled - admin creates users
            selfSignUpEnabled: false,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0aC1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYXV0aC1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFNdkMsTUFBYSxhQUFjLFNBQVEsc0JBQVM7SUFDMUIsUUFBUSxDQUFtQjtJQUMzQixjQUFjLENBQXlCO0lBRXZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0Usb0JBQW9CO1FBQ3BCLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ3JELFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUVoQyxrQkFBa0I7WUFDbEIsYUFBYSxFQUFFO2dCQUNiLEtBQUssRUFBRSxJQUFJO2dCQUNYLFFBQVEsRUFBRSxLQUFLO2FBQ2hCO1lBRUQsOENBQThDO1lBQzlDLGlCQUFpQixFQUFFLEtBQUs7WUFFeEIsa0JBQWtCO1lBQ2xCLGNBQWMsRUFBRTtnQkFDZCxTQUFTLEVBQUUsQ0FBQztnQkFDWixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixhQUFhLEVBQUUsSUFBSTtnQkFDbkIsY0FBYyxFQUFFLEtBQUs7Z0JBQ3JCLG9CQUFvQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQzthQUMzQztZQUVELG1CQUFtQjtZQUNuQixlQUFlLEVBQUUsT0FBTyxDQUFDLGVBQWUsQ0FBQyxVQUFVO1lBRW5ELDBCQUEwQjtZQUMxQixHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxR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QTRCO1FBQzVCLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDL0MsVUFBVSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVTtZQUNwQyxTQUFTLEVBQUUsT0FBTztZQUNsQixXQUFXLEVBQUUsaUNBQWlDO1lBQzlDLFVBQVUsRUFBRSxDQUFDO1NBQ2QsQ0FBQyxDQUFDO1FBRUgsY0FBYztRQUNkLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7WUFDL0MsVUFBVSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVTtZQUNwQyxTQUFTLEVBQUUsT0FBTztZQUNsQixXQUFXLEVBQUUsb0JBQW9CO1lBQ2pDLFVBQVUsRUFBRSxFQUFFO1NBQ2YsQ0FBQyxDQUFDO1FBRUgsMEJBQTBCO1FBQzFCLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUMxRCxVQUFVLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVO1lBQ3BDLFNBQVMsRUFBRSxrQkFBa0I7WUFDN0IsV0FBVyxFQUFFLGdDQUFnQztZQUM3QyxVQUFVLEVBQUUsRUFBRTtTQUNmLENBQUMsQ0FBQztRQUVILGtCQUFrQjtRQUNsQixJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ2hELFVBQVUsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVU7WUFDcEMsU0FBUyxFQUFFLFFBQVE7WUFDbkIsV0FBVyxFQUFFLGtCQUFrQjtZQUMvQixVQUFVLEVBQUUsR0FBRztTQUNoQixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUE5SkQsc0NBOEpDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBdXRoIENvbnN0cnVjdFxuICpcbiAqIERlZmluZXMgQ29nbml0byBVc2VyIFBvb2wgZm9yIGRhc2hib2FyZCBhdXRoZW50aWNhdGlvbi5cbiAqL1xuXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0byc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBBdXRoQ29uc3RydWN0UHJvcHMge1xuICB1c2VyUG9vbE5hbWU6IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEF1dGhDb25zdHJ1Y3QgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgdXNlclBvb2w6IGNvZ25pdG8uVXNlclBvb2w7XG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbENsaWVudDogY29nbml0by5Vc2VyUG9vbENsaWVudDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXV0aENvbnN0cnVjdFByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gQ29nbml0byBVc2VyIFBvb2xcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIHRoaXMudXNlclBvb2wgPSBuZXcgY29nbml0by5Vc2VyUG9vbCh0aGlzLCAnVXNlclBvb2wnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6IHByb3BzLnVzZXJQb29sTmFtZSxcblxuICAgICAgLy8gU2lnbi1pbiBvcHRpb25zXG4gICAgICBzaWduSW5BbGlhc2VzOiB7XG4gICAgICAgIGVtYWlsOiB0cnVlLFxuICAgICAgICB1c2VybmFtZTogZmFsc2UsXG4gICAgICB9LFxuXG4gICAgICAvLyBTZWxmIHNpZ24tdXAgZGlzYWJsZWQgLSBhZG1pbiBjcmVhdGVzIHVzZXJzXG4gICAgICBzZWxmU2lnblVwRW5hYmxlZDogZmFsc2UsXG5cbiAgICAgIC8vIFBhc3N3b3JkIHBvbGljeVxuICAgICAgcGFzc3dvcmRQb2xpY3k6IHtcbiAgICAgICAgbWluTGVuZ3RoOiA4LFxuICAgICAgICByZXF1aXJlTG93ZXJjYXNlOiB0cnVlLFxuICAgICAgICByZXF1aXJlVXBwZXJjYXNlOiB0cnVlLFxuICAgICAgICByZXF1aXJlRGlnaXRzOiB0cnVlLFxuICAgICAgICByZXF1aXJlU3ltYm9sczogZmFsc2UsXG4gICAgICAgIHRlbXBQYXNzd29yZFZhbGlkaXR5OiBjZGsuRHVyYXRpb24uZGF5cyg3KSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEFjY291bnQgcmVjb3ZlcnlcbiAgICAgIGFjY291bnRSZWNvdmVyeTogY29nbml0by5BY2NvdW50UmVjb3ZlcnkuRU1BSUxfT05MWSxcblxuICAgICAgLy8gTUZBIC0gb3B0aW9uYWwgZm9yIGRlbW9cbiAgICAgIG1mYTogY29nbml0by5NZmEuT1BUSU9OQUwsXG4gICAgICBtZmFTZWNvbmRGYWN0b3I6IHtcbiAgICAgICAgc21zOiBmYWxzZSxcbiAgICAgICAgb3RwOiB0cnVlLFxuICAgICAgfSxcblxuICAgICAgLy8gVXNlciB2ZXJpZmljYXRpb25cbiAgICAgIGF1dG9WZXJpZnk6IHtcbiAgICAgICAgZW1haWw6IHRydWUsXG4gICAgICB9LFxuXG4gICAgICAvLyBTdGFuZGFyZCBhdHRyaWJ1dGVzXG4gICAgICBzdGFuZGFyZEF0dHJpYnV0ZXM6IHtcbiAgICAgICAgZW1haWw6IHtcbiAgICAgICAgICByZXF1aXJlZDogdHJ1ZSxcbiAgICAgICAgICBtdXRhYmxlOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICBmdWxsbmFtZToge1xuICAgICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgICAgIG11dGFibGU6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICB9LFxuXG4gICAgICAvLyBDdXN0b20gYXR0cmlidXRlc1xuICAgICAgY3VzdG9tQXR0cmlidXRlczoge1xuICAgICAgICB0ZWFtOiBuZXcgY29nbml0by5TdHJpbmdBdHRyaWJ1dGUoeyBtdXRhYmxlOiB0cnVlIH0pLFxuICAgICAgICByb2xlOiBuZXcgY29nbml0by5TdHJpbmdBdHRyaWJ1dGUoeyBtdXRhYmxlOiB0cnVlIH0pLFxuICAgICAgICAvLyBEaXNwbGF5IHByZWZlcmVuY2VzXG4gICAgICAgIHRlbXBfdW5pdDogbmV3IGNvZ25pdG8uU3RyaW5nQXR0cmlidXRlKHsgbXV0YWJsZTogdHJ1ZSB9KSwgLy8gJ2NlbHNpdXMnIHwgJ2ZhaHJlbmhlaXQnXG4gICAgICAgIHRpbWVfZm9ybWF0OiBuZXcgY29nbml0by5TdHJpbmdBdHRyaWJ1dGUoeyBtdXRhYmxlOiB0cnVlIH0pLCAvLyAnMTJoJyB8ICcyNGgnXG4gICAgICAgIGRlZmF1bHRfdGltZV9yYW5nZTogbmV3IGNvZ25pdG8uU3RyaW5nQXR0cmlidXRlKHsgbXV0YWJsZTogdHJ1ZSB9KSwgLy8gJzEnIHwgJzEyJyB8ICcyNCcgfCAnNDgnIHwgJzE2OCdcbiAgICAgICAgbWFwX3N0eWxlOiBuZXcgY29nbml0by5TdHJpbmdBdHRyaWJ1dGUoeyBtdXRhYmxlOiB0cnVlIH0pLCAvLyAnc3RyZWV0JyB8ICdzYXRlbGxpdGUnXG4gICAgICB9LFxuXG4gICAgICAvLyBFbWFpbCBjb25maWd1cmF0aW9uICh1c2UgQ29nbml0byBkZWZhdWx0IGZvciBkZW1vKVxuICAgICAgZW1haWw6IGNvZ25pdG8uVXNlclBvb2xFbWFpbC53aXRoQ29nbml0bygpLFxuXG4gICAgICAvLyBSZW1vdmFsIHBvbGljeSBmb3IgZGVtbyBlbnZpcm9ubWVudFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVXNlciBQb29sIENsaWVudCAoZm9yIERhc2hib2FyZCBTUEEpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnVzZXJQb29sQ2xpZW50ID0gdGhpcy51c2VyUG9vbC5hZGRDbGllbnQoJ0Rhc2hib2FyZENsaWVudCcsIHtcbiAgICAgIHVzZXJQb29sQ2xpZW50TmFtZTogJ3NvbmdiaXJkLWRhc2hib2FyZCcsXG5cbiAgICAgIC8vIEF1dGggZmxvd3NcbiAgICAgIGF1dGhGbG93czoge1xuICAgICAgICB1c2VyUGFzc3dvcmQ6IHRydWUsXG4gICAgICAgIHVzZXJTcnA6IHRydWUsXG4gICAgICB9LFxuXG4gICAgICAvLyBObyBjbGllbnQgc2VjcmV0IGZvciBTUEFcbiAgICAgIGdlbmVyYXRlU2VjcmV0OiBmYWxzZSxcblxuICAgICAgLy8gVG9rZW4gdmFsaWRpdHlcbiAgICAgIGFjY2Vzc1Rva2VuVmFsaWRpdHk6IGNkay5EdXJhdGlvbi5ob3VycygxKSxcbiAgICAgIGlkVG9rZW5WYWxpZGl0eTogY2RrLkR1cmF0aW9uLmhvdXJzKDEpLFxuICAgICAgcmVmcmVzaFRva2VuVmFsaWRpdHk6IGNkay5EdXJhdGlvbi5kYXlzKDMwKSxcblxuICAgICAgLy8gUHJldmVudCB1c2VyIGV4aXN0ZW5jZSBlcnJvcnMgKHNlY3VyaXR5KVxuICAgICAgcHJldmVudFVzZXJFeGlzdGVuY2VFcnJvcnM6IHRydWUsXG5cbiAgICAgIC8vIE9BdXRoIHNldHRpbmdzIChmb3IgaG9zdGVkIFVJIGlmIG5lZWRlZClcbiAgICAgIG9BdXRoOiB7XG4gICAgICAgIGZsb3dzOiB7XG4gICAgICAgICAgYXV0aG9yaXphdGlvbkNvZGVHcmFudDogdHJ1ZSxcbiAgICAgICAgICBpbXBsaWNpdENvZGVHcmFudDogZmFsc2UsXG4gICAgICAgIH0sXG4gICAgICAgIHNjb3BlczogW1xuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5FTUFJTCxcbiAgICAgICAgICBjb2duaXRvLk9BdXRoU2NvcGUuT1BFTklELFxuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5QUk9GSUxFLFxuICAgICAgICBdLFxuICAgICAgICBjYWxsYmFja1VybHM6IFtcbiAgICAgICAgICAnaHR0cDovL2xvY2FsaG9zdDo1MTczL2NhbGxiYWNrJywgIC8vIFZpdGUgZGV2IHNlcnZlclxuICAgICAgICAgICdodHRwOi8vbG9jYWxob3N0OjMwMDAvY2FsbGJhY2snLFxuICAgICAgICBdLFxuICAgICAgICBsb2dvdXRVcmxzOiBbXG4gICAgICAgICAgJ2h0dHA6Ly9sb2NhbGhvc3Q6NTE3My8nLFxuICAgICAgICAgICdodHRwOi8vbG9jYWxob3N0OjMwMDAvJyxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFVzZXIgUG9vbCBHcm91cHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gQWRtaW4gZ3JvdXAgLSBmdWxsIGFjY2Vzc1xuICAgIG5ldyBjb2duaXRvLkNmblVzZXJQb29sR3JvdXAodGhpcywgJ0FkbWluR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdBZG1pbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FkbWluaXN0cmF0b3JzIHdpdGggZnVsbCBhY2Nlc3MnLFxuICAgICAgcHJlY2VkZW5jZTogMSxcbiAgICB9KTtcblxuICAgIC8vIFNhbGVzIGdyb3VwXG4gICAgbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnU2FsZXNHcm91cCcsIHtcbiAgICAgIHVzZXJQb29sSWQ6IHRoaXMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGdyb3VwTmFtZTogJ1NhbGVzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2FsZXMgdGVhbSBtZW1iZXJzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEwLFxuICAgIH0pO1xuXG4gICAgLy8gRmllbGQgRW5naW5lZXJpbmcgZ3JvdXBcbiAgICBuZXcgY29nbml0by5DZm5Vc2VyUG9vbEdyb3VwKHRoaXMsICdGaWVsZEVuZ2luZWVyaW5nR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdGaWVsZEVuZ2luZWVyaW5nJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRmllbGQgRW5naW5lZXJpbmcgdGVhbSBtZW1iZXJzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEwLFxuICAgIH0pO1xuXG4gICAgLy8gUmVhZC1vbmx5IGdyb3VwXG4gICAgbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnVmlld2VyR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdWaWV3ZXInLFxuICAgICAgZGVzY3JpcHRpb246ICdSZWFkLW9ubHkgYWNjZXNzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEwMCxcbiAgICB9KTtcbiAgfVxufVxuIl19