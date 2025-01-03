import {
  BucketConfig,
  ReplicaConfig,
  ReplicaS3Config,
  ReplicaSwiftConfig,
  S3BucketConfig,
  S3Config,
  SwiftBucketConfig,
  SwiftConfig,
} from "../config/types.ts";
import { getLogger, reportToSentry } from "../utils/log.ts";
import { s3Utils } from "../utils/mod.ts";
import * as s3 from "./s3/objects.ts";
import * as s3_buckets from "./s3/buckets.ts";
import * as swift_buckets from "./swift/buckets.ts";
import * as swift from "./swift/objects.ts";
import { S3_COPY_SOURCE_HEADER } from "../constants/headers.ts";
import { MirrorableCommands, MirrorTask } from "./types.ts";
import taskStore from "./task_store.ts";
import { deserializeToRequest, serializeRequest } from "../utils/url.ts";
import { globalConfig } from "../config/mod.ts";

const logger = getLogger(import.meta);

const kv = taskStore.queue;
const lockedStorages = taskStore.lockedStorages;

export function getBucketFromTask(task: MirrorTask) {
  return task.mainBucketConfig.typ === "S3BucketConfig"
    ? task.mainBucketConfig.config.bucket
    : task.mainBucketConfig.config.container;
}

// update the remote task queue store every 5 minutes
setInterval(async () => {
  await taskStore.syncToRemote();
}, 5 * 60 * 1000); // 5 minutes in milliseconds

function getStorageKey(config: S3Config | SwiftConfig) {
  if ("auth_url" in config) {
    return `swift:${config.auth_url}/${config.region}`;
  }

  return `s3:${config.endpoint}/${config.region}`;
}

export async function enqueueMirrorTask(task: MirrorTask) {
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
  req: Request,
  bucketConfig: S3BucketConfig | SwiftBucketConfig,
  command: MirrorableCommands,
) {
  logger.info("[S3 backend] mirroring requests...");

  const replicaBuckets: ReplicaConfig[] = [];
  for (const replica of globalConfig.replicas) {
    const primaryBucket = bucketConfig.typ === "S3BucketConfig"
      ? bucketConfig.config.bucket
      : bucketConfig.config.container;

    const replicaBucket = replica.typ === "ReplicaS3Config"
      ? replica.config.bucket
      : replica.config.container;

    if (replicaBucket === primaryBucket) {
      replicaBuckets.push(replica);
    }
  }
  for (const backupConfig of replicaBuckets) {
    const task: MirrorTask = {
      mainBucketConfig: bucketConfig,
      backupBucketConfig: backupConfig,
      command: command,
      originalRequest: serializeRequest(req),
      nonce: "",
    };
    await enqueueMirrorTask(task);
  }
}

function _getCopyObjectRequest(
  // This is a PutObject request
  request: Request,
  backupConfig: ReplicaS3Config,
): Request {
  const { bucket, objectKey } = s3Utils.extractRequestInfo(request);
  const copySource = `/${bucket}/${objectKey}`;

  const copyObjectUrl =
    `${backupConfig.config.endpoint}/${backupConfig.config.bucket}/${
      request.url.split("/").pop()
    }`;

  const copyObjectHeaders = new Headers(request.headers);
  copyObjectHeaders.delete(S3_COPY_SOURCE_HEADER);
  copyObjectHeaders.set(S3_COPY_SOURCE_HEADER, copySource);

  const copyObjectRequest = new Request(copyObjectUrl, {
    method: "GET",
    headers: copyObjectHeaders,
  });

  return copyObjectRequest;
}

function getDownloadS3Url(originalRequest: Request, primary: S3BucketConfig) {
  const reqMeta = s3Utils.extractRequestInfo(originalRequest);

  if (reqMeta.urlFormat === "Path") {
    return `${primary.config.endpoint}/${reqMeta.bucket}/${reqMeta.objectKey}`;
  }

  return `${reqMeta.bucket}.${primary.config.endpoint}/${reqMeta.objectKey}`;
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

function generateS3PutObjectHeaders(
  bucketConfig: S3Config,
  contentType: string | undefined,
  contentLength: string | null,
  originalHeaders: Headers,
): Headers {
  const headers = new Headers(originalHeaders);
  headers.set("Host", `${bucketConfig.endpoint}`);
  headers.set("x-amz-date", new Date().toISOString());
  // headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  if (contentType) {
    // headers.set("Content-Type", contentType);
  }

  // headers.set("Transfer-Encoding", "chunked");
  // headers.set("Content-Type", "application/octet-stream");
  if (contentLength) {
    // headers.set("Content-Length", contentLength);
  }
  headers.set(
    "Authorization",
    `AWS4-HMAC-SHA256 Credential=${bucketConfig.credentials.accessKeyId}/${bucketConfig.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
      generateSignature(bucketConfig)
    }`,
  );
  headers.set("expect", "100-continue");
  headers.set("accept-encoding", "gzip, br");
  headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  return headers;
}

function generateSignature(_bucketConfig: S3Config): string {
  // Implement the AWS Signature Version 4 signing process here
  // This is a placeholder function and should be replaced with actual signature generation logic
  return "signature";
}

function extractContentType(request: Request): string {
  const contentType = request.headers.get("Content-Type");
  if (contentType === null) {
    logger.error(`Content-Type header is missing in the request`);
    logger.debug(`Headers: ${JSON.stringify(request.headers)}`);
    reportToSentry("Content-Type header is missing in the request");
    return "application/octet-stream";
  }
  return contentType;
}

export async function mirrorPutObject(
  primary: S3BucketConfig | SwiftBucketConfig,
  replica: ReplicaS3Config | ReplicaSwiftConfig,
  originalRequest: Request,
): Promise<void> {
  if (primary.typ === "S3BucketConfig") {
    // get object from s3
    const getObjectUrl = getDownloadS3Url(originalRequest, primary);
    const getObjectRequest = new Request(getObjectUrl, {
      headers: generateS3GetObjectHeaders(primary.config),
      method: "GET",
    });
    const response = await s3.getObject(getObjectRequest, primary);

    if (!response.ok) {
      const errMesage =
        `Get object failed during mirroing to replica bucket: ${response.statusText}`;
      logger.error(
        errMesage,
      );
      reportToSentry(errMesage);
      return;
    }

    if (replica.typ === "ReplicaS3Config") {
      // put object to s3

      const putToS3Request = new Request(originalRequest.url, {
        method: originalRequest.method,
        body: response.body,
        headers: generateS3PutObjectHeaders(
          replica.config,
          extractContentType(originalRequest),
          response.headers.get("Content-Length"),
          originalRequest.headers,
        ),
      });
      await s3.putObject(putToS3Request, replica.config);
    } else {
      // put object to swift
      const putToSwiftRequest = new Request(originalRequest.url, {
        body: response.body,
        method: originalRequest.method,
        redirect: originalRequest.redirect,
        headers: generateS3PutObjectHeaders(
          {
            endpoint: primary.config.endpoint,
            region: replica.config.region,
            bucket: replica.config.container,
            credentials: {
              accessKeyId: replica.config.credentials.username,
              secretAccessKey: replica.config.credentials.password,
            },
            forcePathStyle: primary.config.forcePathStyle,
          },
          extractContentType(originalRequest),
          response.headers.get("Content-Length"),
          originalRequest.headers,
        ),
      });
      await swift.putObject(putToSwiftRequest, replica.config);
    }
    return;
  }

  // get object from swift
  const getObjectRequest = new Request(originalRequest.url, {
    method: "GET",
    headers: generateS3GetObjectHeaders(
      {
        endpoint: primary.config.auth_url,
        region: primary.config.region,
        bucket: primary.config.container,
        credentials: {
          accessKeyId: primary.config.credentials.username,
          secretAccessKey: primary.config.credentials.password,
        },
        forcePathStyle: true, // FIXME
      },
    ),
  });
  const response = await swift.getObject(getObjectRequest, primary.config);

  if (!response.ok) {
    const errMessage = "Get object failed during mirroring to replica bucket";
    logger.error(
      errMessage,
    );
    reportToSentry(errMessage);
    return;
  }

  // this path means primary is swift
  if (replica.typ === "ReplicaS3Config") {
    // put object to s3
    const putToS3Request = new Request(originalRequest.url, {
      body: response.body,
      headers: generateS3PutObjectHeaders(
        {
          endpoint: replica.config.endpoint,
          region: replica.config.region,
          bucket: replica.config.bucket,
          credentials: {
            accessKeyId: replica.config.credentials.accessKeyId,
            secretAccessKey: replica.config.credentials.secretAccessKey,
          },
          forcePathStyle: replica.config.forcePathStyle,
        },
        extractContentType(originalRequest),
        response.headers.get("Content-Length"),
        originalRequest.headers,
      ),
      method: "PUT",
    });
    await s3.putObject(putToS3Request, replica.config);
  } else {
    const putToSwiftRequest = new Request(originalRequest.url, {
      body: response.body,
      method: "PUT",
      headers: generateS3PutObjectHeaders(
        {
          endpoint: primary.config.auth_url,
          region: primary.config.region,
          bucket: primary.config.container,
          credentials: {
            accessKeyId: primary.config.credentials.username,
            secretAccessKey: primary.config.credentials.password,
          },
          forcePathStyle: true, // FIXME
        },
        extractContentType(originalRequest),
        response.headers.get("Content-Length"),
        originalRequest.headers,
      ),
    });
    await swift.putObject(putToSwiftRequest, replica.config);
  }
}

/**
 * This function mirrors a delete object request to a replica bucket.
 * @param replica
 * @param originalRequest
 */
export async function mirrorDeleteObject(
  replica: ReplicaS3Config | ReplicaSwiftConfig,
  originalRequest: Request,
): Promise<void> {
  switch (replica.typ) {
    case "ReplicaS3Config": {
      const headers = new Headers(originalRequest.headers);
      headers.set(
        "Authorization",
        `AWS4-HMAC-SHA256 Credential=${replica.config.credentials.accessKeyId}/${replica.config.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
          generateSignature(replica.config)
        }`,
      );
      const modifiedRequest = new Request(originalRequest.url, {
        method: originalRequest.method,
        headers: headers,
      });
      await s3.deleteObject(modifiedRequest, replica.config);
      break;
    }
    case "ReplicaSwiftConfig":
      await swift.deleteObject(originalRequest, replica.config);
      break;
    default:
      throw new Error("Invalid replica config type");
  }
}

/**
 * This function mirrors a copy object request to a replica bucket.
 * @param replica
 * @param originalRequest
 */
export async function mirrorCopyObject(
  replica: ReplicaS3Config | ReplicaSwiftConfig,
  originalRequest: Request,
): Promise<void> {
  switch (replica.typ) {
    case "ReplicaS3Config": {
      const headers = new Headers(originalRequest.headers);
      headers.set(
        "Authorization",
        `AWS4-HMAC-SHA256 Credential=${replica.config.credentials.accessKeyId}/${replica.config.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
          generateSignature(replica.config)
        }`,
      );
      const modifiedRequest = new Request(originalRequest.url, {
        method: originalRequest.method,
        headers: headers,
      });
      await s3.copyObject(modifiedRequest, replica.config);
      break;
    }
    case "ReplicaSwiftConfig":
      await swift.copyObject(originalRequest, replica.config);
      break;
    default:
      throw new Error("Invalid replica config type");
  }
}

export async function mirrorCreateBucket(
  originalRequest: Request,
  replica: ReplicaS3Config | ReplicaSwiftConfig,
): Promise<void> {
  if (replica.typ === "ReplicaS3Config") {
    const modifiedRequest = new Request(originalRequest.url, {
      method: originalRequest.method,
      headers: originalRequest.headers,
      body: generateCreateBucketXml(replica.config.region),
    });
    await s3_buckets.createBucket(modifiedRequest, replica.config);
  } else {
    await swift_buckets.createBucket(originalRequest, replica.config);
  }
}

export async function mirrorDeleteBucket(
  originalRequest: Request,
  replica: ReplicaS3Config | ReplicaSwiftConfig,
) {
  if (replica.typ === "ReplicaS3Config") {
    const headers = new Headers(originalRequest.headers);
    headers.set(
      "Authorization",
      `AWS4-HMAC-SHA256 Credential=${replica.config.credentials.accessKeyId}/${replica.config.region}/s3/aws4_request, SignedHeaders=host;x-amz-date;x-amz-content-sha256, Signature=${
        generateSignature(replica.config)
      }`,
    );
    const modifiedRequest = new Request(originalRequest.url, {
      method: originalRequest.method,
      headers: headers,
    });
    await s3_buckets.deleteBucket(modifiedRequest, replica.config);
  } else {
    await swift_buckets.deleteBucket(originalRequest, replica.config);
  }
}

export async function processTask(task: MirrorTask) {
  const {
    command,
    originalRequest: req,
    backupBucketConfig,
    mainBucketConfig,
  } = task;
  const originalRequest = deserializeToRequest(req);
  switch (command) {
    case "putObject":
      await mirrorPutObject(
        mainBucketConfig,
        backupBucketConfig,
        originalRequest,
      );
      break;
    case "deleteObject":
      await mirrorDeleteObject(backupBucketConfig, originalRequest);
      break;
    case "copyObject":
      await mirrorCopyObject(backupBucketConfig, originalRequest);
      break;
    case "createBucket":
      await mirrorCreateBucket(originalRequest, backupBucketConfig);
      break;
    case "deleteBucket":
      await mirrorDeleteBucket(originalRequest, backupBucketConfig);
      break;
  }
}

// FIXME: optimize replica checking
export function hasReplica(bucketConfig: BucketConfig) {
  const bucket = bucketConfig.typ === "S3BucketConfig"
    ? bucketConfig.config.bucket
    : bucketConfig.config.container;
  for (const replica of globalConfig.replicas) {
    const replicaBucket = replica.typ === "ReplicaS3Config"
      ? replica.config.bucket
      : replica.config.container;
    if (replicaBucket === bucket) {
      return true;
    }
  }
  return false;
}
