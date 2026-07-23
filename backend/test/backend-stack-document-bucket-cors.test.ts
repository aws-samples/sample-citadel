/**
 * DocumentBucket CORS — intake document upload NetworkError fix.
 *
 * The browser uploads documents by PUT-ing directly to S3 with a presigned
 * URL (frontend/src/services/documentService.ts → document-upload-resolver).
 * PUT + a non-safelisted Content-Type always force a CORS preflight, so the
 * bucket's AllowedOrigins must cover every origin the SPA is served from:
 *  - https://*.cloudfront.net — the deployed default CloudFront domain. The
 *    distribution lives in FrontendStack, which depends ON BackendStack, so
 *    a domain token cannot be imported here without a circular dependency;
 *    the wildcard covers the default domain.
 *  - http://localhost:3000 / http://127.0.0.1:3000 — Vite dev server
 *    (frontend/vite.config.ts server.port 3000).
 *  - process.env.ALLOWED_ORIGIN, APPENDED when set (custom domains). It must
 *    never REPLACE the baseline list: the old single-slot design
 *    `[process.env.ALLOWED_ORIGIN || 'https://*.cloudfront.net']` meant
 *    localhost could never match → preflight OPTIONS rejected → immediate
 *    "NetworkError when attempting to fetch resource".
 *
 * HEAD is included so the browser/SDK can preflight object HEAD checks.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../src/schema'),
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/lambda/seed-admin-user'),
  path.resolve(__dirname, '../src/lambda/seed-organizations'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from '../lib/backend-stack';

const account = '123456789012';
const region = 'us-east-1';
const documentBucketName = `citadel-documents-test-${account}-${region}`;

function synth(stackId: string): Template {
  const app = new cdk.App();
  const stack = new BackendStack(app, stackId, {
    environment: 'test',
    env: { account, region },
  });
  return Template.fromStack(stack);
}

describe('BackendStack — DocumentBucket CORS (presigned browser PUT preflight)', () => {
  const originalAllowedOrigin = process.env.ALLOWED_ORIGIN;

  afterAll(() => {
    if (originalAllowedOrigin === undefined) {
      delete process.env.ALLOWED_ORIGIN;
    } else {
      process.env.ALLOWED_ORIGIN = originalAllowedOrigin;
    }
  });

  describe('default synth (no ALLOWED_ORIGIN)', () => {
    let template: Template;

    beforeAll(() => {
      delete process.env.ALLOWED_ORIGIN;
      template = synth('TestBackendStackDocBucketCors');
    });

    test('allows the CloudFront wildcard AND both Vite dev-server origins', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: documentBucketName,
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedOrigins: Match.arrayWith([
                'https://*.cloudfront.net',
                'http://localhost:3000',
                'http://127.0.0.1:3000',
              ]),
            }),
          ]),
        },
      });
    });

    test('allows GET, PUT, POST and HEAD with all headers and maxAge 3000', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: documentBucketName,
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
              AllowedHeaders: ['*'],
              MaxAge: 3000,
            }),
          ]),
        },
      });
    });
  });

  describe('ALLOWED_ORIGIN set at synth time', () => {
    test('appends the custom origin WITHOUT dropping the baseline origins', () => {
      process.env.ALLOWED_ORIGIN = 'https://app.example.com';
      const template = synth('TestBackendStackDocBucketCorsCustomOrigin');
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: documentBucketName,
        CorsConfiguration: {
          CorsRules: Match.arrayWith([
            Match.objectLike({
              AllowedOrigins: Match.arrayWith([
                'https://*.cloudfront.net',
                'http://localhost:3000',
                'http://127.0.0.1:3000',
                'https://app.example.com',
              ]),
            }),
          ]),
        },
      });
    });
  });
});
