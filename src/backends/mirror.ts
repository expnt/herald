import { RequestContext } from "./../types/mod.ts";
import { S3Config, SwiftConfig } from "../config/types.ts";
import { getLogger, reportToSentry } from "../utils/log.ts";
import { s3Utils } from "../utils/mod.ts";
import * as s3 from "./s3/objects.ts";
import * as s3_buckets from "./s3/buckets.ts";
import * as swift_buckets from "./swift/buckets.ts";
import * as swift from "./swift/objects.ts";
import { MirrorableCommands, MirrorTask } from "./types.ts";
import { deserializeToRequest, serializeRequest } from "../utils/url.ts";
import { bucketStore } from "../config/mod.ts";
import { TASK_QUEUE_DB } from "../constants/message.ts";
import { Bucket } from "../buckets/mod.ts";
import { HeraldError } from "../types/http-exception.ts";
import { Result } from "option-t/plain_result";
import { createErr, isOk, unwrapErr, unwrapOk } from "option-t/plain_result";

const logger = getLogger(import.meta);

export function getBucketFromTask(task: MirrorTask) {
  return task.mainBucketConfig.bucketName;
}

function getStorageKey(config: S3Config | SwiftConfig) {
  if ("auth_url" in config) {
    return `swift:${config.auth_url}/${config.region}`;
  }

  return `s3:${config.endpoint}/${config.region}`;
}

export async function enqueueMirrorTask(
  reqCtx: RequestContext,
  task: MirrorTask,
) {
  const bucket = getBucketFromTask(task);
  const kv = await Deno.openKv(`${bucket}_${TASK_QUEUE_DB}`);
  const lockedStorages = reqCtx.heraldContext.taskStore.lockedStorages;
  const nonce = crypto.randomUUID(); // Unique identifier for the task
  task.nonce = nonce;
  logger.debug(
    `Enqueing task: ${task.command} for primary: ${task.mainBucketConfig.typ} to replica: ${task.backupBucketConfig.typ}`,
  );

  // Atomic transaction to add the task to the queue
  const storageKey = getStorageKey(task.backupBucketConfig.config);
  const currentCount = lockedStorages.get(storageKey) || 0;
  lockedStorages.set(storageKey, currentCount + 1);

  await kv.enqueue(task);
  logger.debug(
    `Task enqueued: ${task.command} for primary: ${task.mainBucketConfig.typ} to replica: ${task.backupBucketConfig.typ}`,
  );
}

export async function prepareMirrorRequests(
  ctx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
  command: MirrorableCommands,
) {
  logger.info("Mirroring requests...");

  for (const backupConfig of bucketConfig.replicas) {
    const task: MirrorTask = {
      mainBucketConfig: bucketConfig,
      backupBucketConfig: backupConfig,
      command: command,
      originalRequest: serializeRequest(req),
      nonce: "",
      retryCount: 0,
    };
    await enqueueMirrorTask(ctx, task);
  }
}

function getDownloadS3Url(originalRequest: Request, config: S3Config) {
  const reqMeta = s3Utils.extractRequestInfo(originalRequest);

  if (reqMeta.urlFormat === "Path") {
    return `${config.endpoint}/${reqMeta.bucket}/${reqMeta.objectKey}`;
  }

  return `${reqMeta.bucket}.${config.endpoint}/${reqMeta.objectKey}`;
}

function generateCreateBucketXml(region: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
}

function generateS3GetObjectHeaders(
  bucketConfig: S3Config,
): Headers {
  const headers = new Headers();
  headers.set("Host", `${bucketConfig.endpoint}`);
  headers.set("x-amz-date", new Date().toISOString());
  headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${bucketConfig.credentials.accessKeyId}/${bucketConfig.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
      generateSignature(bucketConfig)
    }`,
  );
  return headers;
}

function generateSignature(_bucketConfig: S3Config): string {
  // Implement the AWS Signature Version 4 signing process here
  // This is a placeholder function and should be replaced with actual signature generation logic
  return "signature";
}

async function mirrorPutObject(
  reqCtx: RequestContext,
  originalRequest: Request,
  primary: Bucket,
  replica: Bucket,
): Promise<Result<Response, Error>> {
  if (primary.typ === "S3BucketConfig") {
    // get object from s3
    const getObjectUrl = getDownloadS3Url(
      originalRequest,
      primary.config as S3Config,
    );
    const getObjectRequest = new Request(getObjectUrl, {
      headers: generateS3GetObjectHeaders(primary.config as S3Config),
      method: "GET",
    });

    const primaryBucket = bucketStore.buckets.find((bucket) =>
      bucket.name === primary.bucketName
    )!;
    const response = await s3.getObject(
      reqCtx,
      getObjectRequest,
      primaryBucket,
    );

    if (!isOk(response)) {
      const errRes = unwrapErr(response);
      const errMessage =
        `Get object failed during mirroring to replica bucket: ${errRes.message}`;
      logger.error(
        errMessage,
      );
      reportToSentry(errMessage);
      return response;
    }

    const successResponse = unwrapOk(response);
    if (!successResponse.ok) {
      const errMessage =
        `Get object failed during mirroing to replica bucket: ${successResponse.statusText}`;
      logger.error(
        errMessage,
      );
      reportToSentry(errMessage);
      return createErr(
        new HeraldError(successResponse.status, { message: errMessage }),
      );
    }

    if (replica.typ === "ReplicaS3Config") {
      // put object to s3

      const replicaBucket = primaryBucket.getReplica(replica.name)!;
      const putToS3Request = new Request(originalRequest.url, {
        method: "PUT",
        body: successResponse.body,
        headers: originalRequest.headers,
      });
      return await s3.putObject(reqCtx, putToS3Request, replicaBucket);
    } else {
      // put object to swift
      const replicaBucket = primaryBucket.getReplica(replica.name)!;
      const putToSwiftRequest = new Request(originalRequest.url, {
        body: successResponse.body,
        method: "PUT",
        redirect: originalRequest.redirect,
        headers: originalRequest.headers,
      });
      return await swift.putObject(reqCtx, putToSwiftRequest, replicaBucket);
    }
  }

  // get object from swift
  const config = primary.config as SwiftConfig;
  const getObjectRequest = new Request(originalRequest.url, {
    method: "GET",
    headers: generateS3GetObjectHeaders(
      {
        endpoint: config.auth_url,
        region: config.region,
        bucket: config.container,
        credentials: {
          accessKeyId: config.credentials.username,
          secretAccessKey: config.credentials.password,
        },
        forcePathStyle: true, // FIXME
        typ: "S3Config",
      },
    ),
  });
  const primaryBucket = bucketStore.buckets.find((bucket) =>
    bucket.name === config.container
  )!;
  const response = await swift.getObject(
    reqCtx,
    getObjectRequest,
    primaryBucket,
  );

  if (!isOk(response)) {
    const errRes = unwrapErr(response);
    const errMessage =
      `Get object failed during mirroring to replica bucket: ${errRes.message}`;
    logger.error(
      errMessage,
    );
    reportToSentry(errMessage);
    return response;
  }

  const successResponse = unwrapOk(response);
  if (!successResponse.ok) {
    const errMessage = "Get object failed during mirroring to replica bucket";
    logger.error(
      errMessage,
    );
    reportToSentry(errMessage);
    return createErr(
      new HeraldError(successResponse.status, { message: errMessage }),
    );
  }

  // this path means primary is swift
  if (replica.typ === "ReplicaS3Config") {
    // put object to s3
    const putToS3Request = new Request(originalRequest.url, {
      body: successResponse.body,
      headers: originalRequest.headers,
      method: "PUT",
    });
    if (successResponse.headers.has("accept-ranges")) {
      putToS3Request.headers.set(
        "accept-ranges",
        successResponse.headers.get("accept-ranges")!,
      );
    }
    if (successResponse.headers.has("content-length")) {
      putToS3Request.headers.set(
        "content-length",
        successResponse.headers.get("content-length")!,
      );
    }
    if (successResponse.headers.has("content-type")) {
      putToS3Request.headers.set(
        "content-type",
        successResponse.headers.get("content-type")!,
      );
    }
    const replicaBucket = primaryBucket.getReplica(replica.name)!;
    putToS3Request.headers.set(
      "x-amz-content-sha256",
      "UNSIGNED-PAYLOAD",
    );
    return await s3.putObject(reqCtx, putToS3Request, replicaBucket);
  } else {
    const putToSwiftRequest = new Request(originalRequest.url, {
      body: successResponse.body,
      method: "PUT",
      headers: originalRequest.headers,
    });
    const replicaBucket = primaryBucket.getReplica(replica.name)!;
    return await swift.putObject(reqCtx, putToSwiftRequest, replicaBucket);
  }
}

/**
 * This function mirrors a delete object request to a replica bucket.
 * @param replica
 * @param originalRequest
 */
async function mirrorDeleteObject(
  reqCtx: RequestContext,
  originalRequest: Request,
  replica: Bucket,
): Promise<Result<Response, Error>> {
  const primaryBucket = bucketStore.buckets.find((bucket) =>
    bucket.bucketName === replica.bucketName
  )!;
  switch (replica.typ) {
    case "ReplicaS3Config": {
      const config = replica.config as S3Config;
      const headers = new Headers(originalRequest.headers);
      headers.set(
        "Authorization",
        `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${config.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
          generateSignature(config)
        }`,
      );
      const modifiedRequest = new Request(originalRequest.url, {
        method: originalRequest.method,
        headers: headers,
      });
      const replicaBucket = primaryBucket.getReplica(replica.name)!;
      return await s3.deleteObject(reqCtx, modifiedRequest, replicaBucket);
    }
    case "ReplicaSwiftConfig": {
      const replicaBucket = primaryBucket.getReplica(replica.name)!;
      return await swift.deleteObject(reqCtx, originalRequest, replicaBucket);
    }
    default:
      logger.critical(`Invalid replica config type: ${replica.typ}`);
      // we wouldn't reach here since schema gets validated,
      throw new Error("Invalid replica config type");
  }
}

/**
 * This function mirrors a copy object request to a replica bucket.
 * @param replica
 * @param originalRequest
 */
async function mirrorCopyObject(
  ctx: RequestContext,
  originalRequest: Request,
  replica: Bucket,
): Promise<Result<Response, Error>> {
  const primaryBucket = bucketStore.buckets.find((bucket) =>
    bucket.bucketName === replica.bucketName
  )!;
  switch (replica.typ) {
    case "ReplicaS3Config": {
      const config = replica.config as S3Config;
      const headers = new Headers(originalRequest.headers);
      headers.set(
        "Authorization",
        `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${config.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
          generateSignature(config)
        }`,
      );
      const modifiedRequest = new Request(originalRequest.url, {
        method: originalRequest.method,
        headers: headers,
      });
      const replicaBucket = primaryBucket.getReplica(replica.name)!;
      return await s3.copyObject(ctx, modifiedRequest, replicaBucket);
    }
    case "ReplicaSwiftConfig": {
      const replicaBucket = primaryBucket.getReplica(replica.name)!;
      return await swift.copyObject(ctx, originalRequest, replicaBucket);
    }
    default:
      logger.critical(`Invalid replica config type: ${replica.typ}`);
      // we wouldn't reach here since schema gets validated,
      throw new Error("Invalid replica config type");
  }
}

async function mirrorCreateBucket(
  reqCtx: RequestContext,
  originalRequest: Request,
  replica: Bucket,
): Promise<Result<Response, Error>> {
  const primaryBucket = bucketStore.buckets.find((bucket) =>
    bucket.bucketName === replica.bucketName
  )!;
  if (replica.typ === "ReplicaS3Config") {
    const config = replica.config as S3Config;
    const xmlBody = generateCreateBucketXml(config.region);
    const headers = new Headers();
    headers.set("Content-Type", "application/xml");
    headers.set("Content-Length", xmlBody.length.toString());

    const modifiedRequest = new Request(originalRequest.url, {
      method: originalRequest.method, // Should be PUT for Create Bucket
      headers: headers,
      body: xmlBody,
    });
    const replicaBucket = primaryBucket.getReplica(replica.name)!;
    return await s3_buckets.createBucket(
      reqCtx,
      modifiedRequest,
      replicaBucket,
    );
  } else {
    const replicaBucket = primaryBucket.getReplica(replica.name)!;
    return await swift_buckets.createBucket(
      reqCtx,
      originalRequest,
      replicaBucket,
    );
  }
}

async function mirrorDeleteBucket(
  reqCtx: RequestContext,
  originalRequest: Request,
  replica: Bucket,
): Promise<Result<Response, Error>> {
  const primaryBucket = bucketStore.buckets.find((bucket) =>
    bucket.bucketName === replica.bucketName
  )!;
  if (replica.typ === "ReplicaS3Config") {
    const config = replica.config as S3Config;
    const headers = new Headers(originalRequest.headers);
    headers.set(
      "Authorization",
      `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${replica.config.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
        generateSignature(config)
      }`,
    );
    const modifiedRequest = new Request(originalRequest.url, {
      method: originalRequest.method,
      headers: headers,
    });
    const replicaBucket = primaryBucket.getReplica(replica.name)!;
    return await s3_buckets.deleteBucket(
      reqCtx,
      modifiedRequest,
      replicaBucket,
    );
  } else {
    const replicaBucket = primaryBucket.getReplica(replica.name)!;
    return await swift_buckets.deleteBucket(
      reqCtx,
      originalRequest,
      replicaBucket,
    );
  }
}

async function mirrorCompleteMultipartUpload(
  ctx: RequestContext,
  originalRequest: Request,
  primary: Bucket,
  replica: Bucket,
): Promise<Result<Response, Error>> {
  const url = new URL(originalRequest.url);
  url.searchParams.delete("uploadId");
  const modifiedUrl = url.toString();
  const modifiedRequest = new Request(modifiedUrl, originalRequest);

  return await mirrorPutObject(ctx, modifiedRequest, primary, replica);
}

export async function processTask(
  reqCtx: RequestContext,
  task: MirrorTask,
): Promise<Result<Response, Error>> {
  const {
    command,
    originalRequest: req,
    backupBucketConfig,
    mainBucketConfig,
  } = task;
  const originalRequest = deserializeToRequest(req);
  switch (command) {
    case "putObject":
      return await mirrorPutObject(
        reqCtx,
        originalRequest,
        mainBucketConfig,
        backupBucketConfig,
      );
    case "deleteObject":
      return await mirrorDeleteObject(
        reqCtx,
        originalRequest,
        backupBucketConfig,
      );
    case "copyObject":
      return await mirrorCopyObject(
        reqCtx,
        originalRequest,
        backupBucketConfig,
      );
    case "createBucket":
      return await mirrorCreateBucket(
        reqCtx,
        originalRequest,
        backupBucketConfig,
      );
    case "deleteBucket":
      return await mirrorDeleteBucket(
        reqCtx,
        originalRequest,
        backupBucketConfig,
      );
    case "completeMultipartUpload":
      return await mirrorCompleteMultipartUpload(
        reqCtx,
        originalRequest,
        mainBucketConfig,
        backupBucketConfig,
      );
  }
}
