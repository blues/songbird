#!/usr/bin/env node
"use strict";
/**
 * Songbird Infrastructure CDK App
 *
 * Entry point for AWS CDK deployment of Songbird cloud infrastructure.
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
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const songbird_stack_1 = require("../lib/songbird-stack");
const app = new cdk.App();
// Get configuration from context or environment
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-1',
};
// Notehub configuration
const notehubProjectUid = app.node.tryGetContext('notehubProjectUid') || 'com.blues.songbird';
new songbird_stack_1.SongbirdStack(app, 'SongbirdStack', {
    env,
    description: 'Songbird Demo Platform - AWS Infrastructure',
    notehubProjectUid,
    // Tag all resources
    tags: {
        Project: 'Songbird',
        Environment: 'production',
        ManagedBy: 'CDK',
    },
});
app.synth();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic29uZ2JpcmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9iaW4vc29uZ2JpcmQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFDQTs7OztHQUlHOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsdUNBQXFDO0FBQ3JDLGlEQUFtQztBQUNuQywwREFBc0Q7QUFFdEQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsZ0RBQWdEO0FBQ2hELE1BQU0sR0FBRyxHQUFHO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxjQUFjO0lBQ3RFLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQixJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsVUFBVSxJQUFJLFdBQVc7Q0FDaEYsQ0FBQztBQUVGLHdCQUF3QjtBQUN4QixNQUFNLGlCQUFpQixHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLG1CQUFtQixDQUFDLElBQUksb0JBQW9CLENBQUM7QUFFOUYsSUFBSSw4QkFBYSxDQUFDLEdBQUcsRUFBRSxlQUFlLEVBQUU7SUFDdEMsR0FBRztJQUNILFdBQVcsRUFBRSw2Q0FBNkM7SUFDMUQsaUJBQWlCO0lBRWpCLG9CQUFvQjtJQUNwQixJQUFJLEVBQUU7UUFDSixPQUFPLEVBQUUsVUFBVTtRQUNuQixXQUFXLEVBQUUsWUFBWTtRQUN6QixTQUFTLEVBQUUsS0FBSztLQUNqQjtDQUNGLENBQUMsQ0FBQztBQUVILEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbi8qKlxuICogU29uZ2JpcmQgSW5mcmFzdHJ1Y3R1cmUgQ0RLIEFwcFxuICpcbiAqIEVudHJ5IHBvaW50IGZvciBBV1MgQ0RLIGRlcGxveW1lbnQgb2YgU29uZ2JpcmQgY2xvdWQgaW5mcmFzdHJ1Y3R1cmUuXG4gKi9cblxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFNvbmdiaXJkU3RhY2sgfSBmcm9tICcuLi9saWIvc29uZ2JpcmQtc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuXG4vLyBHZXQgY29uZmlndXJhdGlvbiBmcm9tIGNvbnRleHQgb3IgZW52aXJvbm1lbnRcbmNvbnN0IGVudiA9IHtcbiAgYWNjb3VudDogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfQUNDT1VOVCB8fCBwcm9jZXNzLmVudi5BV1NfQUNDT1VOVF9JRCxcbiAgcmVnaW9uOiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9SRUdJT04gfHwgcHJvY2Vzcy5lbnYuQVdTX1JFR0lPTiB8fCAndXMtZWFzdC0xJyxcbn07XG5cbi8vIE5vdGVodWIgY29uZmlndXJhdGlvblxuY29uc3Qgbm90ZWh1YlByb2plY3RVaWQgPSBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdub3RlaHViUHJvamVjdFVpZCcpIHx8ICdjb20uYmx1ZXMuc29uZ2JpcmQnO1xuXG5uZXcgU29uZ2JpcmRTdGFjayhhcHAsICdTb25nYmlyZFN0YWNrJywge1xuICBlbnYsXG4gIGRlc2NyaXB0aW9uOiAnU29uZ2JpcmQgRGVtbyBQbGF0Zm9ybSAtIEFXUyBJbmZyYXN0cnVjdHVyZScsXG4gIG5vdGVodWJQcm9qZWN0VWlkLFxuXG4gIC8vIFRhZyBhbGwgcmVzb3VyY2VzXG4gIHRhZ3M6IHtcbiAgICBQcm9qZWN0OiAnU29uZ2JpcmQnLFxuICAgIEVudmlyb25tZW50OiAncHJvZHVjdGlvbicsXG4gICAgTWFuYWdlZEJ5OiAnQ0RLJyxcbiAgfSxcbn0pO1xuXG5hcHAuc3ludGgoKTtcbiJdfQ==