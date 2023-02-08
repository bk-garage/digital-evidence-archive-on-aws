/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  ListPartsOutput,
  Part,
} from '@aws-sdk/client-s3';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getRequiredEnv } from '../lambda-http-helpers';
import { DeaCaseFile } from '../models/case-file';

const region = process.env.AWS_REGION ?? 'us-east-1';

export interface DatasetsProvider {
  s3Client: S3Client;
  bucketName: string;
}

export const defaultDatasetsProvider = {
  s3Client: new S3Client({ region }),
  bucketName: getRequiredEnv('DATASETS_BUCKET_NAME', 'DATASETS_BUCKET_NAME is not set in your lambda!'),
};

export const generatePresignedUrlsForCaseFile = async (
  caseFile: DeaCaseFile,
  datasetsProvider: DatasetsProvider = defaultDatasetsProvider
): Promise<void> => {
  const s3Key = _getS3KeyForCaseFile(caseFile);

  // define constants
  const response = await datasetsProvider.s3Client.send(
    new CreateMultipartUploadCommand({
      Bucket: datasetsProvider.bucketName,
      Key: s3Key,
      BucketKeyEnabled: true,
      ServerSideEncryption: 'aws:kms',
      //ChecksumAlgorithm: 'SHA256'
      ContentType: caseFile.contentType,
      ObjectLockLegalHoldStatus: 'ON',
      StorageClass: 'INTELLIGENT_TIERING',
    })
  );

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const uploadId = response.UploadId as string;

  // using 500MB chunks so we can support a max file size of 5TB with a max of 10,000 chunks
  // limits obtained from link below on 2/7/2023
  // https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
  const fileParts = Math.ceil(caseFile.fileSizeMb / 500); // fixme: chunk size should be a variable for testing purposes
  const presignedUrlPromises = [];
  for (let i = 0; i < fileParts; i++) {
    presignedUrlPromises[i] = _getPresignedUrlPromise(
      datasetsProvider.bucketName,
      s3Key,
      uploadId,
      i + 1,
      datasetsProvider.s3Client
    );
  }
  await Promise.all(presignedUrlPromises).then((presignedUrls) => {
    caseFile.presignedUrls = presignedUrls;
  });

  // update ddb with upload-id
  caseFile.uploadId = uploadId;
};

export const completeUploadForCaseFile = async (
  caseFile: DeaCaseFile,
  datasetsProvider: DatasetsProvider = defaultDatasetsProvider
): Promise<void> => {
  let uploadedParts: Part[] = [];
  let listPartsResponse: ListPartsOutput;
  let partNumberMarker;
  /* eslint-disable no-await-in-loop */
  do {
    listPartsResponse = await datasetsProvider.s3Client.send(
      new ListPartsCommand({
        Bucket: datasetsProvider.bucketName,
        Key: _getS3KeyForCaseFile(caseFile),
        PartNumberMarker: partNumberMarker,
        UploadId: caseFile.uploadId,
      })
    );
    if (listPartsResponse !== undefined && listPartsResponse.Parts) {
      uploadedParts = uploadedParts.concat(
        listPartsResponse.Parts.map(function (part) {
          return { ETag: part.ETag, PartNumber: part.PartNumber };
        })
      );
    }

    partNumberMarker = listPartsResponse.NextPartNumberMarker;
  } while (listPartsResponse.IsTruncated);

  await datasetsProvider.s3Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: datasetsProvider.bucketName,
      Key: _getS3KeyForCaseFile(caseFile),
      //ChecksumSHA256: deaCaseFile.sha256Hash,
      UploadId: caseFile.uploadId,
      MultipartUpload: { Parts: uploadedParts },
    })
  );
};

function _getS3KeyForCaseFile(caseFile: DeaCaseFile): string {
  return `${caseFile.caseUlid}/${caseFile.ulid}`;
}

async function _getPresignedUrlPromise(
  bucket: string,
  s3Key: string,
  uploadId: string,
  partNumber: number,
  s3Client: S3Client
): Promise<string> {
  const uploadPartCommand = new UploadPartCommand({
    Bucket: bucket,
    Key: s3Key,
    UploadId: uploadId,
    PartNumber: partNumber,
  });
  return getSignedUrl(s3Client, uploadPartCommand, { expiresIn: 3600 });
}
