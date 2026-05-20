const fs = require('fs');
const { parse, buildSchema } = require('graphql');
const sdl = fs.readFileSync('src/schema/schema.graphql', 'utf8');

// 1. Syntax check
try {
  parse(sdl);
  console.log('OK: schema is syntactically valid (parse succeeded)');
} catch (e) {
  console.error('SYNTAX ERROR:', e.message);
  process.exit(1);
}

// 2. Type-reference check with AppSync shims so that AWSDateTime/AWSJSON/@aws_* resolve
const shim = `
scalar AWSDateTime
scalar AWSJSON
scalar AWSURL
scalar AWSEmail
scalar AWSTimestamp
scalar AWSDate
scalar AWSTime
scalar AWSPhone
scalar AWSIPAddress
directive @aws_iam on FIELD_DEFINITION | OBJECT
directive @aws_cognito_user_pools(cognito_groups: [String]) on FIELD_DEFINITION | OBJECT
directive @aws_api_key on FIELD_DEFINITION | OBJECT
directive @aws_subscribe(mutations: [String!]!) on FIELD_DEFINITION
directive @aws_auth(cognito_groups: [String]) on FIELD_DEFINITION
directive @aws_oidc on FIELD_DEFINITION | OBJECT
directive @aws_lambda on FIELD_DEFINITION | OBJECT
`;
try {
  buildSchema(shim + '\n' + sdl);
  console.log('OK: all type references resolve with AppSync shim');
} catch (e) {
  console.error('TYPE ERROR:', e.message);
  process.exit(1);
}
