/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import { completeCaseFileUpload } from '@aws/dea-app/lib/app/resources/complete-case-file-upload';
import { CaseAction } from '@aws/dea-app/lib/models/case-action';
import { createDeaHandler } from './create-dea-handler';

export const handler = createDeaHandler(completeCaseFileUpload, [CaseAction.UPLOAD]);
