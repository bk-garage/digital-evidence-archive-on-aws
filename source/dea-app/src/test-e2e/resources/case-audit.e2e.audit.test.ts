/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import { Credentials } from 'aws4-axios';
import Joi from 'joi';
import { AuditEventType } from '../../app/services/audit-service';
import { Oauth2Token } from '../../models/auth';
import { joiUlid } from '../../models/validation/joi-common';
import CognitoHelper from '../helpers/cognito-helper';
import { testEnv } from '../helpers/settings';
import {
  callDeaAPIWithCreds,
  CaseAuditEventEntry,
  createCaseSuccess,
  delay,
  deleteCase,
  parseCaseAuditCsv,
  randomSuffix,
} from './test-helpers';

describe('case audit e2e', () => {
  const cognitoHelper = new CognitoHelper();

  const suffix = randomSuffix();
  const testUser = `caseAuditTestUser${suffix}`;
  const unauthorizedUser = `caseAuditTestUserUnauth${suffix}`;
  const deaApiUrl = testEnv.apiUrlOutput;
  let creds: Credentials;
  let idToken: Oauth2Token;
  let managerCreds: Credentials;
  let managerToken: Oauth2Token;

  const caseIdsToDelete: string[] = [];

  beforeAll(async () => {
    // Create user in test group
    await cognitoHelper.createUser(testUser, 'CaseWorker', 'CaseAudit', 'TestUser');
    await cognitoHelper.createUser(unauthorizedUser, 'EvidenceManager', 'CaseAudit', 'UnauthorizedUser');
    [creds, idToken] = await cognitoHelper.getCredentialsForUser(testUser);
    [managerCreds, managerToken] = await cognitoHelper.getCredentialsForUser(unauthorizedUser);
  }, 10000);

  afterAll(async () => {
    for (const caseId of caseIdsToDelete) {
      await deleteCase(deaApiUrl, caseId, idToken, creds);
    }
    await cognitoHelper.cleanup();
  }, 30000);

  it('retrieves actions taken against a case', async () => {
    const caseName = `auditTestCase${randomSuffix()}`;
    const createdCase = await createCaseSuccess(
      deaApiUrl,
      {
        name: caseName,
        description: 'this is a description',
      },
      idToken,
      creds
    );
    const caseUlid = createdCase.ulid ?? fail();
    caseIdsToDelete.push(caseUlid);

    const updateResponse = await callDeaAPIWithCreds(
      `${deaApiUrl}cases/${caseUlid}/details`,
      'PUT',
      idToken,
      creds,
      {
        ulid: caseUlid,
        name: caseName,
        description: 'An updated description',
      }
    );
    expect(updateResponse.status).toEqual(200);

    const getResponse = await callDeaAPIWithCreds(
      `${deaApiUrl}cases/${caseUlid}/details`,
      'GET',
      idToken,
      creds
    );
    expect(getResponse.status).toEqual(200);

    const membershipsResponse = await callDeaAPIWithCreds(
      `${deaApiUrl}cases/${caseUlid}/userMemberships`,
      'GET',
      idToken,
      creds
    );
    expect(membershipsResponse.status).toEqual(200);

    // allow some time so the events show up in CW logs
    await delay(25000);

    let csvData: string | undefined;
    const queryRetries = 5;
    while (!csvData && queryRetries > 0) {
      const startAuditQueryResponse = await callDeaAPIWithCreds(
        `${deaApiUrl}cases/${caseUlid}/audit`,
        'POST',
        idToken,
        creds
      );

      expect(startAuditQueryResponse.status).toEqual(200);
      const auditId: string = startAuditQueryResponse.data.auditId;
      Joi.assert(auditId, joiUlid);

      let retries = 5;
      await delay(5000);
      let getQueryReponse = await callDeaAPIWithCreds(
        `${deaApiUrl}cases/${caseUlid}/audit/${auditId}/csv`,
        'GET',
        idToken,
        creds
      );
      while (getQueryReponse.data.status && retries > 0) {
        if (getQueryReponse.data.status === 'Complete') {
          break;
        }
        --retries;
        if (getQueryReponse.status !== 200) {
          fail();
        }
        await delay(2000);

        getQueryReponse = await callDeaAPIWithCreds(
          `${deaApiUrl}cases/${caseUlid}/audit/${auditId}/csv`,
          'GET',
          idToken,
          creds
        );
      }

      const potentialCsvData: string = getQueryReponse.data;

      if (
        getQueryReponse.data &&
        !getQueryReponse.data.status &&
        potentialCsvData.includes(AuditEventType.UPDATE_CASE_DETAILS) &&
        potentialCsvData.includes(AuditEventType.GET_CASE_DETAILS) &&
        potentialCsvData.includes(AuditEventType.GET_USERS_FROM_CASE) &&
        potentialCsvData.match(/dynamodb.amazonaws.com/g)?.length === 6
      ) {
        csvData = getQueryReponse.data;
      } else {
        await delay(10000);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const entries = parseCaseAuditCsv(csvData!).filter(
      (entry) =>
        entry.eventType != AuditEventType.GET_CASE_AUDIT &&
        entry.eventType != AuditEventType.REQUEST_CASE_AUDIT
    );

    expect(entries.length).toBe(10);
    // 1. CreateCase
    // 2. TransactWriteItems
    // 3. UpdateCaseDetails
    // 4. DB Get
    // 5. TransactWriteItems
    // 6. DB Get
    // 7. GetCaseDetails
    // 8. DB Get
    // 9. GetUsersFromCase
    // 10. DB Get

    const dbGetItems = entries.filter((entry) => entry.eventDetails === 'GetItem');
    expect(dbGetItems).toHaveLength(4);
    const dbTransactItems = entries.filter((entry) => entry.eventDetails === 'TransactWriteItems');
    expect(dbTransactItems).toHaveLength(2);

    function verifyCaseAuditEntry(
      entry: CaseAuditEventEntry | undefined,
      expectedEventType: AuditEventType,
      expectedUsername: string
    ) {
      if (!entry) {
        fail('Entry does not exist');
      }
      expect(entry.eventType).toStrictEqual(expectedEventType);
      expect(entry.username).toStrictEqual(expectedUsername);
      expect(entry.caseId).toStrictEqual(caseUlid);
    }

    const createCaseEntry = entries.find((entry) => entry.eventType === AuditEventType.CREATE_CASE);
    verifyCaseAuditEntry(createCaseEntry, AuditEventType.CREATE_CASE, testUser);

    const updateCaseDetails = entries.find((entry) => entry.eventType === AuditEventType.UPDATE_CASE_DETAILS);
    verifyCaseAuditEntry(updateCaseDetails, AuditEventType.UPDATE_CASE_DETAILS, testUser);

    const getCaseDetailsEntry = entries.find((entry) => entry.eventType === AuditEventType.GET_CASE_DETAILS);
    verifyCaseAuditEntry(getCaseDetailsEntry, AuditEventType.GET_CASE_DETAILS, testUser);

    const getUsersFromCaseEntry = entries.find(
      (entry) => entry.eventType === AuditEventType.GET_USERS_FROM_CASE
    );
    verifyCaseAuditEntry(getUsersFromCaseEntry, AuditEventType.GET_USERS_FROM_CASE, testUser);
  }, 720000);

  it('should prevent retrieval by an unauthorized user', async () => {
    const caseName = `auditTestCase${randomSuffix()}`;
    const createdCase = await createCaseSuccess(
      deaApiUrl,
      {
        name: caseName,
        description: 'this is a description',
      },
      idToken,
      creds
    );
    const caseUlid = createdCase.ulid ?? fail();
    caseIdsToDelete.push(caseUlid);

    //get an audit id with an authorized user (case membership)
    const startAuditQueryResponse = await callDeaAPIWithCreds(
      `${deaApiUrl}cases/${caseUlid}/audit`,
      'POST',
      idToken,
      creds
    );

    expect(startAuditQueryResponse.status).toEqual(200);
    const auditId: string = startAuditQueryResponse.data.auditId;
    Joi.assert(auditId, joiUlid);

    // now use that audit id with an unauthorized user via a different csv endpoint that they have access to
    const getQueryReponse = await callDeaAPIWithCreds(
      `${deaApiUrl}system/audit/${auditId}/csv`,
      'GET',
      managerToken,
      managerCreds
    );

    expect(getQueryReponse.status).toEqual(404);
  });
});
