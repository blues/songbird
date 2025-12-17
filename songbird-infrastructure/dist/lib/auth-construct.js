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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXV0aC1jb25zdHJ1Y3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9saWIvYXV0aC1jb25zdHJ1Y3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsaURBQW1DO0FBQ25DLGlFQUFtRDtBQUNuRCwyQ0FBdUM7QUFNdkMsTUFBYSxhQUFjLFNBQVEsc0JBQVM7SUFDMUIsUUFBUSxDQUFtQjtJQUMzQixjQUFjLENBQXlCO0lBRXZELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUI7UUFDakUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQiw2RUFBNkU7UUFDN0Usb0JBQW9CO1FBQ3BCLDZFQUE2RTtRQUM3RSxJQUFJLENBQUMsUUFBUSxHQUFHLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFO1lBQ3JELFlBQVksRUFBRSxLQUFLLENBQUMsWUFBWTtZQUVoQyxrQkFBa0I7WUFDbEIsYUFBYSxFQUFFO2dCQUNiLEtBQUssRUFBRSxJQUFJO2dCQUNYLFFBQVEsRUFBRSxLQUFLO2FBQ2hCO1lBRUQsOENBQThDO1lBQzlDLGlCQUFpQixFQUFFLEtBQUs7WUFFeEIsa0JBQWtCO1lBQ2xCLGNBQWMsRUFBRTtnQkFDZCxTQUFTLEVBQUUsQ0FBQztnQkFDWixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixnQkFBZ0IsRUFBRSxJQUFJO2dCQUN0QixhQUFhLEVBQUUsSUFBSTtnQkFDbkIsY0FBYyxFQUFFLEtBQUs7Z0JBQ3JCLG9CQUFvQixFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQzthQUMzQztZQUVELG1CQUFtQjtZQUNuQixlQUFlLEVBQUUsT0FBTyxDQUFDLGVBQWUsQ0FBQyxVQUFVO1lBRW5ELDBCQUEwQjtZQUMxQixHQUFHLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxR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QUFDLENBQUM7UUFFSCwwQkFBMEI7UUFDMUIsSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQzFELFVBQVUsRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLFVBQVU7WUFDcEMsU0FBUyxFQUFFLGtCQUFrQjtZQUM3QixXQUFXLEVBQUUsZ0NBQWdDO1lBQzdDLFVBQVUsRUFBRSxFQUFFO1NBQ2YsQ0FBQyxDQUFDO1FBRUgsa0JBQWtCO1FBQ2xCLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDaEQsVUFBVSxFQUFFLElBQUksQ0FBQyxRQUFRLENBQUMsVUFBVTtZQUNwQyxTQUFTLEVBQUUsUUFBUTtZQUNuQixXQUFXLEVBQUUsa0JBQWtCO1lBQy9CLFVBQVUsRUFBRSxHQUFHO1NBQ2hCLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXpKRCxzQ0F5SkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEF1dGggQ29uc3RydWN0XG4gKlxuICogRGVmaW5lcyBDb2duaXRvIFVzZXIgUG9vbCBmb3IgZGFzaGJvYXJkIGF1dGhlbnRpY2F0aW9uLlxuICovXG5cbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBjb2duaXRvIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEF1dGhDb25zdHJ1Y3RQcm9wcyB7XG4gIHVzZXJQb29sTmFtZTogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQXV0aENvbnN0cnVjdCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSB1c2VyUG9vbDogY29nbml0by5Vc2VyUG9vbDtcbiAgcHVibGljIHJlYWRvbmx5IHVzZXJQb29sQ2xpZW50OiBjb2duaXRvLlVzZXJQb29sQ2xpZW50O1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBdXRoQ29uc3RydWN0UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICAvLyBDb2duaXRvIFVzZXIgUG9vbFxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgdGhpcy51c2VyUG9vbCA9IG5ldyBjb2duaXRvLlVzZXJQb29sKHRoaXMsICdVc2VyUG9vbCcsIHtcbiAgICAgIHVzZXJQb29sTmFtZTogcHJvcHMudXNlclBvb2xOYW1lLFxuXG4gICAgICAvLyBTaWduLWluIG9wdGlvbnNcbiAgICAgIHNpZ25JbkFsaWFzZXM6IHtcbiAgICAgICAgZW1haWw6IHRydWUsXG4gICAgICAgIHVzZXJuYW1lOiBmYWxzZSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIFNlbGYgc2lnbi11cCBkaXNhYmxlZCAtIGFkbWluIGNyZWF0ZXMgdXNlcnNcbiAgICAgIHNlbGZTaWduVXBFbmFibGVkOiBmYWxzZSxcblxuICAgICAgLy8gUGFzc3dvcmQgcG9saWN5XG4gICAgICBwYXNzd29yZFBvbGljeToge1xuICAgICAgICBtaW5MZW5ndGg6IDgsXG4gICAgICAgIHJlcXVpcmVMb3dlcmNhc2U6IHRydWUsXG4gICAgICAgIHJlcXVpcmVVcHBlcmNhc2U6IHRydWUsXG4gICAgICAgIHJlcXVpcmVEaWdpdHM6IHRydWUsXG4gICAgICAgIHJlcXVpcmVTeW1ib2xzOiBmYWxzZSxcbiAgICAgICAgdGVtcFBhc3N3b3JkVmFsaWRpdHk6IGNkay5EdXJhdGlvbi5kYXlzKDcpLFxuICAgICAgfSxcblxuICAgICAgLy8gQWNjb3VudCByZWNvdmVyeVxuICAgICAgYWNjb3VudFJlY292ZXJ5OiBjb2duaXRvLkFjY291bnRSZWNvdmVyeS5FTUFJTF9PTkxZLFxuXG4gICAgICAvLyBNRkEgLSBvcHRpb25hbCBmb3IgZGVtb1xuICAgICAgbWZhOiBjb2duaXRvLk1mYS5PUFRJT05BTCxcbiAgICAgIG1mYVNlY29uZEZhY3Rvcjoge1xuICAgICAgICBzbXM6IGZhbHNlLFxuICAgICAgICBvdHA6IHRydWUsXG4gICAgICB9LFxuXG4gICAgICAvLyBVc2VyIHZlcmlmaWNhdGlvblxuICAgICAgYXV0b1ZlcmlmeToge1xuICAgICAgICBlbWFpbDogdHJ1ZSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIFN0YW5kYXJkIGF0dHJpYnV0ZXNcbiAgICAgIHN0YW5kYXJkQXR0cmlidXRlczoge1xuICAgICAgICBlbWFpbDoge1xuICAgICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgICAgIG11dGFibGU6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIGZ1bGxuYW1lOiB7XG4gICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgICAgbXV0YWJsZTogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG5cbiAgICAgIC8vIEN1c3RvbSBhdHRyaWJ1dGVzXG4gICAgICBjdXN0b21BdHRyaWJ1dGVzOiB7XG4gICAgICAgIHRlYW06IG5ldyBjb2duaXRvLlN0cmluZ0F0dHJpYnV0ZSh7IG11dGFibGU6IHRydWUgfSksXG4gICAgICAgIHJvbGU6IG5ldyBjb2duaXRvLlN0cmluZ0F0dHJpYnV0ZSh7IG11dGFibGU6IHRydWUgfSksXG4gICAgICB9LFxuXG4gICAgICAvLyBFbWFpbCBjb25maWd1cmF0aW9uICh1c2UgQ29nbml0byBkZWZhdWx0IGZvciBkZW1vKVxuICAgICAgZW1haWw6IGNvZ25pdG8uVXNlclBvb2xFbWFpbC53aXRoQ29nbml0bygpLFxuXG4gICAgICAvLyBSZW1vdmFsIHBvbGljeSBmb3IgZGVtbyBlbnZpcm9ubWVudFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICB9KTtcblxuICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gICAgLy8gVXNlciBQb29sIENsaWVudCAoZm9yIERhc2hib2FyZCBTUEEpXG4gICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbiAgICB0aGlzLnVzZXJQb29sQ2xpZW50ID0gdGhpcy51c2VyUG9vbC5hZGRDbGllbnQoJ0Rhc2hib2FyZENsaWVudCcsIHtcbiAgICAgIHVzZXJQb29sQ2xpZW50TmFtZTogJ3NvbmdiaXJkLWRhc2hib2FyZCcsXG5cbiAgICAgIC8vIEF1dGggZmxvd3NcbiAgICAgIGF1dGhGbG93czoge1xuICAgICAgICB1c2VyUGFzc3dvcmQ6IHRydWUsXG4gICAgICAgIHVzZXJTcnA6IHRydWUsXG4gICAgICB9LFxuXG4gICAgICAvLyBObyBjbGllbnQgc2VjcmV0IGZvciBTUEFcbiAgICAgIGdlbmVyYXRlU2VjcmV0OiBmYWxzZSxcblxuICAgICAgLy8gVG9rZW4gdmFsaWRpdHlcbiAgICAgIGFjY2Vzc1Rva2VuVmFsaWRpdHk6IGNkay5EdXJhdGlvbi5ob3VycygxKSxcbiAgICAgIGlkVG9rZW5WYWxpZGl0eTogY2RrLkR1cmF0aW9uLmhvdXJzKDEpLFxuICAgICAgcmVmcmVzaFRva2VuVmFsaWRpdHk6IGNkay5EdXJhdGlvbi5kYXlzKDMwKSxcblxuICAgICAgLy8gUHJldmVudCB1c2VyIGV4aXN0ZW5jZSBlcnJvcnMgKHNlY3VyaXR5KVxuICAgICAgcHJldmVudFVzZXJFeGlzdGVuY2VFcnJvcnM6IHRydWUsXG5cbiAgICAgIC8vIE9BdXRoIHNldHRpbmdzIChmb3IgaG9zdGVkIFVJIGlmIG5lZWRlZClcbiAgICAgIG9BdXRoOiB7XG4gICAgICAgIGZsb3dzOiB7XG4gICAgICAgICAgYXV0aG9yaXphdGlvbkNvZGVHcmFudDogdHJ1ZSxcbiAgICAgICAgICBpbXBsaWNpdENvZGVHcmFudDogZmFsc2UsXG4gICAgICAgIH0sXG4gICAgICAgIHNjb3BlczogW1xuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5FTUFJTCxcbiAgICAgICAgICBjb2duaXRvLk9BdXRoU2NvcGUuT1BFTklELFxuICAgICAgICAgIGNvZ25pdG8uT0F1dGhTY29wZS5QUk9GSUxFLFxuICAgICAgICBdLFxuICAgICAgICBjYWxsYmFja1VybHM6IFtcbiAgICAgICAgICAnaHR0cDovL2xvY2FsaG9zdDo1MTczL2NhbGxiYWNrJywgIC8vIFZpdGUgZGV2IHNlcnZlclxuICAgICAgICAgICdodHRwOi8vbG9jYWxob3N0OjMwMDAvY2FsbGJhY2snLFxuICAgICAgICBdLFxuICAgICAgICBsb2dvdXRVcmxzOiBbXG4gICAgICAgICAgJ2h0dHA6Ly9sb2NhbGhvc3Q6NTE3My8nLFxuICAgICAgICAgICdodHRwOi8vbG9jYWxob3N0OjMwMDAvJyxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuICAgIC8vIFVzZXIgUG9vbCBHcm91cHNcbiAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4gICAgLy8gQWRtaW4gZ3JvdXAgLSBmdWxsIGFjY2Vzc1xuICAgIG5ldyBjb2duaXRvLkNmblVzZXJQb29sR3JvdXAodGhpcywgJ0FkbWluR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdBZG1pbicsXG4gICAgICBkZXNjcmlwdGlvbjogJ0FkbWluaXN0cmF0b3JzIHdpdGggZnVsbCBhY2Nlc3MnLFxuICAgICAgcHJlY2VkZW5jZTogMSxcbiAgICB9KTtcblxuICAgIC8vIFNhbGVzIGdyb3VwXG4gICAgbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnU2FsZXNHcm91cCcsIHtcbiAgICAgIHVzZXJQb29sSWQ6IHRoaXMudXNlclBvb2wudXNlclBvb2xJZCxcbiAgICAgIGdyb3VwTmFtZTogJ1NhbGVzJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU2FsZXMgdGVhbSBtZW1iZXJzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEwLFxuICAgIH0pO1xuXG4gICAgLy8gRmllbGQgRW5naW5lZXJpbmcgZ3JvdXBcbiAgICBuZXcgY29nbml0by5DZm5Vc2VyUG9vbEdyb3VwKHRoaXMsICdGaWVsZEVuZ2luZWVyaW5nR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdGaWVsZEVuZ2luZWVyaW5nJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRmllbGQgRW5naW5lZXJpbmcgdGVhbSBtZW1iZXJzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEwLFxuICAgIH0pO1xuXG4gICAgLy8gUmVhZC1vbmx5IGdyb3VwXG4gICAgbmV3IGNvZ25pdG8uQ2ZuVXNlclBvb2xHcm91cCh0aGlzLCAnVmlld2VyR3JvdXAnLCB7XG4gICAgICB1c2VyUG9vbElkOiB0aGlzLnVzZXJQb29sLnVzZXJQb29sSWQsXG4gICAgICBncm91cE5hbWU6ICdWaWV3ZXInLFxuICAgICAgZGVzY3JpcHRpb246ICdSZWFkLW9ubHkgYWNjZXNzJyxcbiAgICAgIHByZWNlZGVuY2U6IDEwMCxcbiAgICB9KTtcbiAgfVxufVxuIl19