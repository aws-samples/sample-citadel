# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import urllib3

SUCCESS = "SUCCESS"
FAILED = "FAILED"

http = urllib3.PoolManager()

def send(event, context, responseStatus, responseData, physicalResourceId=None, noEcho=False, reason=None):
    responseUrl = event['ResponseURL']

    print("Sending response to CloudFormation")

    responseBody = {
        'Status': responseStatus,
        'Reason': reason or "See the details in CloudWatch Log Stream: {}".format(context.log_stream_name),
        'PhysicalResourceId': physicalResourceId or context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'NoEcho': noEcho,
        'Data': responseData
    }

    json_responseBody = json.dumps(responseBody)

    # Do not log the full response body: the 'Data' field may contain sensitive
    # values (generated secrets, passwords, ARNs). Log only non-sensitive metadata
    # and the Data key *count* (never key names/values, and never read back through
    # responseBody, which embeds the sensitive Data field).
    print(
        "Response status: {}; physicalResourceId={}; stackId={}; requestId={}; "
        "logicalResourceId={}; dataKeyCount={}".format(
            responseStatus,
            physicalResourceId or context.log_stream_name,
            event['StackId'],
            event['RequestId'],
            event['LogicalResourceId'],
            len(responseData) if isinstance(responseData, dict) else 0,
        )
    )

    headers = {
        'content-type': '',
        'content-length': str(len(json_responseBody))
    }

    try:
        response = http.request('PUT', responseUrl, headers=headers, body=json_responseBody)
        print("Status code:", response.status)
    except Exception as e:
        print("send(..) failed executing http.request(..):", e)
