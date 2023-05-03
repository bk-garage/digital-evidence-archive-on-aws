/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { Duration, aws_events_targets } from 'aws-cdk-lib';
import { Rule } from 'aws-cdk-lib/aws-events';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { deaConfig } from '../config';
import { createCfnOutput } from './construct-support';

interface LambdaEnvironment {
  [key: string]: string;
}

interface DeaEventHandlerProps {
  deaTableArn: string;
  deaDatasetsBucketArn: string;
  lambdaEnv: LambdaEnvironment;
  kmsKey: Key;
}

export class DeaEventHandlers extends Construct {
  public s3BatchDeleteCaseFileLambda: NodejsFunction;
  public s3BatchDeleteCaseFileRole: Role;

  public constructor(scope: Construct, stackName: string, props: DeaEventHandlerProps) {
    super(scope, stackName);

    const s3BatchDeleteCaseFileRole = this.createS3BatchDeleteCaseFileRole(
      's3-batch-delete-case-file-handler-role',
      props.deaTableArn,
      props.deaDatasetsBucketArn,
      props.kmsKey.keyArn
    );

    this.s3BatchDeleteCaseFileLambda = this.createLambda(
      `s3_batch_delete_case_file`,
      'S3BatchDeleteCaseFileLambda',
      '../../src/handlers/s3-batch-delete-case-file-handler.ts',
      props.lambdaEnv,
      s3BatchDeleteCaseFileRole
    );

    const statusHandlerRole = this.createS3BatchStatusChangeHandlerRole(
      's3-batch-status-change-handler-role',
      props.deaTableArn,
      props.deaDatasetsBucketArn,
      props.kmsKey.keyArn
    );

    const s3BatchJobStatusChangeHandlerLambda = this.createLambda(
      `s3_batch_status_handler`,
      'S3BatchJobStatusChangeLambda',
      '../../src/handlers/s3-batch-job-status-change-handler.ts',
      props.lambdaEnv,
      statusHandlerRole
    );

    this.s3BatchDeleteCaseFileRole = this.createS3BatchRole(props.deaDatasetsBucketArn);

    // create event bridge rule
    this.createEventBridgeRuleForS3BatchJobs(s3BatchJobStatusChangeHandlerLambda);
  }

  private createEventBridgeRuleForS3BatchJobs(targetLambda: NodejsFunction) {
    new Rule(this, 'S3BatchJobStatusChangeRule', {
      enabled: true,
      eventPattern: {
        source: ['aws.s3'],
        detail: {
          eventSource: ['s3.amazonaws.com'],
          eventName: ['JobStatusChanged'],
        },
      },
      targets: [new aws_events_targets.LambdaFunction(targetLambda)],
    });
  }

  private createLambda(
    id: string,
    cfnExportName: string,
    pathToSource: string,
    lambdaEnv: LambdaEnvironment,
    role: Role
  ): NodejsFunction {
    const lambda = new NodejsFunction(this, id, {
      memorySize: 512,
      role,
      timeout: Duration.seconds(60),
      runtime: Runtime.NODEJS_18_X,
      handler: 'handler',
      entry: path.join(__dirname, pathToSource),
      depsLockFilePath: path.join(__dirname, '../../../common/config/rush/pnpm-lock.yaml'),
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        STAGE: deaConfig.stage(),
        ...lambdaEnv,
      },
      bundling: {
        externalModules: ['aws-sdk'],
        minify: true,
        sourceMap: true,
      },
    });

    createCfnOutput(this, cfnExportName, {
      value: lambda.functionArn,
    });

    return lambda;
  }

  private createS3BatchRole(datasetsBucketArn: string): Role {
    const role = new Role(this, 's3-batch-delete-case-file-role', {
      assumedBy: new ServicePrincipal('batchoperations.s3.amazonaws.com'),
    });

    role.addToPolicy(
      new PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
        resources: [`${datasetsBucketArn}/manifests/*`, `${datasetsBucketArn}/reports/*`],
      })
    );

    role.addToPolicy(
      new PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [this.s3BatchDeleteCaseFileLambda.functionArn],
      })
    );

    return role;
  }

  private createS3BatchDeleteCaseFileRole(
    id: string,
    tableArn: string,
    datasetsBucketArn: string,
    kmsKeyArn: string
  ): Role {
    const basicExecutionPolicy = ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AWSLambdaBasicExecutionRole'
    );
    const role = new Role(this, id, {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [basicExecutionPolicy],
    });

    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [tableArn],
      })
    );

    role.addToPolicy(
      new PolicyStatement({
        actions: [
          's3:DeleteObject',
          's3:DeleteObjectVersion',
          's3:GetObjectLegalHold',
          's3:PutObjectLegalHold',
        ],
        resources: [`${datasetsBucketArn}/*`],
      })
    );

    role.addToPolicy(
      new PolicyStatement({
        actions: ['s3:DescribeJob'],
        resources: ['*'],
      })
    );

    role.addToPolicy(
      new PolicyStatement({
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [kmsKeyArn],
      })
    );

    return role;
  }

  private createS3BatchStatusChangeHandlerRole(
    id: string,
    tableArn: string,
    datasetsBucketArn: string,
    kmsKeyArn: string
  ): Role {
    const basicExecutionPolicy = ManagedPolicy.fromAwsManagedPolicyName(
      'service-role/AWSLambdaBasicExecutionRole'
    );
    const role = new Role(this, id, {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [basicExecutionPolicy],
    });

    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [tableArn],
      })
    );

    role.addToPolicy(
      new PolicyStatement({
        actions: ['s3:DescribeJob'],
        resources: ['*'],
      })
    );

    role.addToPolicy(
      new PolicyStatement({
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [kmsKeyArn],
      })
    );

    return role;
  }
}