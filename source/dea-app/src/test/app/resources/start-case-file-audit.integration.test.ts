/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import Joi from 'joi';
import { anything, instance, mock, when } from 'ts-mockito';
import { startCaseFileAudit } from '../../../app/resources/start-case-file-audit';
import { joiUlid } from '../../../models/validation/joi-common';
import { ModelRepositoryProvider } from '../../../persistence/schema/entities';
import { bogusUlid } from '../../../test-e2e/resources/test-helpers';
import { dummyContext, getDummyEvent } from '../../integration-objects';
import { getTestRepositoryProvider } from '../../persistence/local-db-table';

describe('start case file audit', () => {
  const OLD_ENV = process.env;

  let modelProvider: ModelRepositoryProvider;
  beforeAll(async () => {
    modelProvider = await getTestRepositoryProvider('startCaseFileAuditIntegration');
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    process.env.AUDIT_LOG_GROUP_NAME = 'TESTGROUP';
    process.env.TRAIL_LOG_GROUP_NAME = 'TESTTRAILGROUP';
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('responds with a queryId', async () => {
    const clientMock: CloudWatchLogsClient = mock(CloudWatchLogsClient);
    const clientMockInstance = instance(clientMock);
    when(clientMock.send(anything())).thenResolve({ $metadata: {}, queryId: 'a_query_id' });

    const event = getDummyEvent({
      pathParameters: {
        caseId: bogusUlid,
        fileId: bogusUlid,
      },
    });
    const result = await startCaseFileAudit(
      event,
      dummyContext,
      modelProvider,
      undefined,
      clientMockInstance
    );

    expect(result.statusCode).toEqual(200);
    const body: { auditId: string } = JSON.parse(result.body);
    Joi.assert(body.auditId, joiUlid);
  });

  it('throws an error if no queryId is returned', async () => {
    const clientMock: CloudWatchLogsClient = mock(CloudWatchLogsClient);
    const clientMockInstance = instance(clientMock);
    when(clientMock.send(anything())).thenResolve({ $metadata: {}, queryId: undefined });

    const event = getDummyEvent({
      pathParameters: {
        caseId: bogusUlid,
        fileId: bogusUlid,
      },
    });
    await expect(
      startCaseFileAudit(event, dummyContext, modelProvider, undefined, clientMockInstance)
    ).rejects.toThrow('Unknown error starting Cloudwatch Logs Query.');
  });
});