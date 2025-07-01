import { getLogger, reportToSentry } from "../utils/log.ts";
import { MirrorTask } from "./types.ts";
import { GlobalConfig, S3Config } from "../config/types.ts";
import { TASK_QUEUE_DB } from "../constants/message.ts";
import {
  createErr,
  createOk,
  isOk,
  Result,
  unwrapErr,
  unwrapOk,
} from "option-t/plain_result";
import { RequestContext } from "../types/mod.ts";
import {
  getObject as swiftGetObject,
  putObject as swiftPutObject,
} from "./swift/objects.ts";
import { Bucket } from "../buckets/mod.ts";
import { getBucket } from "../config/loader.ts";
import { globalConfig } from "../config/mod.ts";
import { KeystoneTokenStore } from "./swift/keystone_token_store.ts";
import {
  GetObjectCommand,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client,
} from "aws-sdk/client-s3";
import { s3Utils } from "../utils/mod.ts";

const logger = getLogger(import.meta);

async function s3GetObject(
  _reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  // Use the AWS SDK for JavaScript v3 (deno compatible) to get an object from S3
  // Assume bucketConfig.config contains the S3 config (endpoint, region, credentials, bucket, etc.)

  // Importing here for Deno compatibility (if not already imported at the top)
  // import { S3Client, GetObjectCommand } from "npm:@aws-sdk/client-s3";

  try {
    const config = bucketConfig.config as S3Config;
    const s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: true,
    });

    const { objectKey: key, bucket } = s3Utils.extractRequestInfo(req);
    if (!key || !bucket) {
      return createErr(new Error("Object key or bucket is required"));
    }

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const s3Response = await s3Client.send(command);

    // Convert S3 GetObjectCommandOutput to a Response object
    const body = s3Response.Body
      ? (typeof s3Response.Body.transformToWebStream === "function"
        ? s3Response.Body.transformToWebStream()
        : s3Response.Body)
      : null;

    const headers = new Headers();
    if (s3Response.ContentType) {
      headers.set("content-type", s3Response.ContentType);
    }
    if (s3Response.ContentLength !== undefined) {
      headers.set("content-length", String(s3Response.ContentLength));
    }
    if (s3Response.ETag) headers.set("etag", s3Response.ETag);

    // Add any other headers from s3Response as needed

    const response = new Response(body, {
      status: 200,
      headers,
    });

    return createOk(response);
  } catch (err) {
    logger.error(`s3GetObject error: ${err}`);
    reportToSentry(err as Error);
    return createErr(err instanceof Error ? err : new Error(String(err)));
  }
}

async function s3PutObject(
  _reqCtx: RequestContext,
  req: Request,
  bucketConfig: Bucket,
): Promise<Result<Response, Error>> {
  try {
    const config = bucketConfig.config as S3Config;
    const s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: true,
    });

    const { objectKey: key, bucket } = s3Utils.extractRequestInfo(req);
    if (!key || !bucket) {
      return createErr(new Error("Object key or bucket is required"));
    }

    const putParams: PutObjectCommandInput = {
      Bucket: bucket,
      Key: key,
      Body: await req.text(),
    };

    const command = new PutObjectCommand(putParams);

    const s3Response = await s3Client.send(command);

    // Construct a minimal Response to satisfy the Result<Response, Error> type
    const headers = new Headers();
    if (s3Response.ETag) headers.set("etag", s3Response.ETag);

    // You may add more headers from s3Response as needed

    const response = new Response(null, {
      status: 200,
      headers,
    });

    return createOk(response);
  } catch (err) {
    logger.error(`s3PutObject error: ${err}`);
    reportToSentry(err as Error);
    return createErr(err instanceof Error ? err : new Error(String(err)));
  }
}

interface TaskStoreStorage {
  putObject: (
    reqCtx: RequestContext,
    req: Request,
    bucketConfig: Bucket,
  ) => Promise<Result<Response, Error>>;
  getObject: (
    reqCtx: RequestContext,
    req: Request,
    bucketConfig: Bucket,
  ) => Promise<Result<Response, Error>>;
}

/**
 * The TaskStore class is responsible for managing tasks and their states,
 * including synchronization with a remote storage (S3) and local storage (Deno.Kv).
 * It follows a singleton pattern to ensure only one instance is used throughout the application.
 *
 * @remarks
 * The TaskStore class provides methods to serialize and deserialize the task queue and locks,
 * upload and fetch data from S3, and synchronize the local state with the remote storage.
 *
 * @example
 * ```typescript
 * const remoteStorageConfig: S3Config = { /* S3 configuration * / };
 * const taskStore = await TaskStore.getInstance(remoteStorageConfig);
 * ```
 */
export class TaskStore {
  private static instance: Promise<TaskStore> | null = null;

  public static getInstance(
    buckets: string[],
    keystoneStore: KeystoneTokenStore,
  ): Promise<TaskStore> {
    async function inner() {
      const remoteStorage = getBucket("task-store");
      if (!remoteStorage) {
        logger.error(
          "Remote storage configuration for 'task-store' bucket not found",
        );
        throw new Error(
          "Remote storage configuration for 'task-store' bucket not found",
        );
      }
      let storage: TaskStoreStorage;
      switch (remoteStorage.typ) {
        case "S3Config":
          storage = {
            putObject: s3PutObject,
            getObject: s3GetObject,
          };
          break;
        case "SwiftConfig":
          storage = {
            putObject: swiftPutObject,
            getObject: swiftGetObject,
          };
          break;
        default:
          logger.error(
            `Unknown remote storage type: ${remoteStorage.typ}`,
          );
          throw new Error(
            `Unknown remote storage type: ${remoteStorage.typ}`,
          );
      }

      const taskQueues: [string, Deno.Kv][] = [];
      for (const bucket of buckets) {
        const kv = await Deno.openKv(`${bucket}_${TASK_QUEUE_DB}`);
        taskQueues.push([bucket, kv]);
      }
      const lockedStorages = new Map<string, number>();

      const newInstance = new TaskStore(
        storage,
        taskQueues,
        lockedStorages,
        buckets,
        keystoneStore,
        remoteStorage,
      );
      await newInstance.#syncFromRemote();

      return newInstance;
    }
    if (!TaskStore.instance) {
      TaskStore.instance = inner();
    }
    return TaskStore.instance;
  }

  constructor(
    private s3: TaskStoreStorage,
    private _queues: [string, Deno.Kv][],
    private _lockedStorages: Map<string, number>,
    private buckets: string[],
    private keystoneStore: KeystoneTokenStore,
    private remoteStorage: Bucket,
  ) {}

  async #serializeQueue(queue: Deno.Kv) {
    const entries = [];
    // Iterate over all entries in the store
    for await (const entry of queue.list({ prefix: [] })) {
      // Collect the key-value pairs
      entries.push({
        key: entry.key.join("/"), // Join key parts if necessary for string representation
        value: entry.value,
      });
    }

    // Serialize the collected entries to JSON
    const json = JSON.stringify(entries, null, 2);

    return json;
  }

  #serailizeLocks() {
    const locks = Array.from(this._lockedStorages.entries());
    const json = JSON.stringify(locks, null, 2);

    return json;
  }

  async #deserializeQueue(
    queueString: string,
    bucket: string,
  ): Promise<Deno.Kv> {
    const entries = JSON.parse(queueString);
    const newQueue = await Deno.openKv(this.#getDbName(bucket));

    for (const entry of entries) {
      const key = entry.key.split("/") as Deno.KvKey; // Split key parts if necessary
      newQueue.set(key, entry.value as MirrorTask);
    }

    return newQueue;
  }

  #deserializeLocks(queueString: string): Result<Map<string, number>, Error> {
    try {
      const locks = JSON.parse(queueString);
      const newLocks = new Map<string, number>(locks);
      return createOk(newLocks);
    } catch (err) {
      const errMessage =
        `Failed to deserialize locks from remote storage: ${err}`;
      logger.critical(errMessage);
      reportToSentry(errMessage);
      return createErr(err as Error);
    }
  }

  async #uploadToS3(body: string, key: string) {
    const bucket = "task-store";
    const objectKey = key;
    const s3Url =
      `http://localhost:${globalConfig.port}/${bucket}/${objectKey}`;

    // Convert Blob to ArrayBuffer
    const encoder = new TextEncoder();
    const bodyBuffer = encoder.encode(body);
    const contentLength = bodyBuffer.byteLength.toString();

    // Prepare headers
    const headers: Record<string, string> = {
      host: `localhost:${globalConfig.port}`,
      "Content-Type": "application/json", // Explicitly set content type
      "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD", // Add the pre-calculated SHA256 hash
      "Content-Length": contentLength,
    };

    // Create the Request object
    const request = new Request(s3Url, {
      method: "PUT",
      headers,
      body: ReadableStream.from([bodyBuffer]),
    });

    try {
      const reqCtx: RequestContext = {
        logger,
        heraldContext: {
          taskStore: this,
          keystoneStore: this.keystoneStore,
        },
      };

      // If this.s3.putObject respects the X-Amz-Content-Sha256 header,
      // it won't need to consume the body stream to calculate it again.
      // It should just use the stream for the actual network send.
      const response = await this.s3.putObject(
        reqCtx,
        request,
        this.remoteStorage,
      );

      if (!isOk(response)) {
        const errRes = unwrapErr(response);
        const errMessage =
          `Error uploading object with key: ${key} to remote task store (HTTP ${errRes.message})`;
        logger.warn(errMessage);
        // reportToSentry(errMessage); // Uncomment if Sentry is configured
        throw errRes;
      }

      const successResponse = unwrapOk(response);
      if (successResponse.status !== 200) {
        const errMessage =
          `Failed to upload object with key: ${key} to remote store (HTTP ${successResponse.status})`;
        logger.warn(errMessage);
        // reportToSentry(errMessage); // Uncomment if Sentry is configured
        throw new Error(errMessage);
      }
    } catch (error) {
      const errMessage =
        `Error uploading object with key: ${key} to remote store: ${error}`;
      logger.critical(errMessage);
      // reportToSentry(errMessage); // Uncomment if Sentry is configured
      // Re-throw the error if you want it to propagate further
      throw error;
    }
  }

  async #getObject(key: string) {
    // Instead of using the SDK, manually construct the HTTP request for S3 GetObject
    const bucket = "task-store";
    const objectKey = key;

    const s3Url =
      `http://localhost:${globalConfig.port}/${bucket}/${objectKey}`;

    // Prepare headers (add authentication if needed)
    const headers: Record<string, string> = {
      host: `localhost:${globalConfig.port}`,
      // Add any required headers here, e.g., for authentication
      // For public buckets, this may be empty
    };

    const request = new Request(s3Url, {
      method: "GET",
      headers,
    });
    try {
      const reqCtx: RequestContext = {
        logger,
        heraldContext: {
          taskStore: this,
          keystoneStore: this.keystoneStore,
        },
      };
      const response = await this.s3.getObject(
        reqCtx,
        request,
        this.remoteStorage,
      );

      if (!isOk(response)) {
        const errRes = unwrapErr(response);
        const errMessage =
          `Error fetching object with key: ${key} to remote task store (HTTP ${errRes.message})`;
        logger.warn(errMessage);
        reportToSentry(errMessage);
        throw errRes;
      }

      const successResponse = unwrapOk(response);
      if (successResponse.status !== 200) {
        const errMessage =
          `Failed to fetch object with key: ${key} from remote task store (HTTP ${successResponse.status})`;
        logger.warn(
          errMessage,
        );
        reportToSentry(errMessage);
        throw new Error(errMessage);
      }

      if (!successResponse.body) {
        const errMessage =
          `Failed to read the body of ${key} from remote task store`;
        logger.warn(
          errMessage,
        );
        reportToSentry(errMessage);
      }

      if (successResponse.body) {
        const reader = successResponse.body.getReader();
        const decoder = new TextDecoder();
        let result = "";
        let done = false;

        while (!done) {
          const { value, done: streamDone } = await reader.read();
          done = streamDone;
          if (value) {
            result += decoder.decode(value, { stream: true });
          }
        }

        return result;
      }
      return undefined;
    } catch (error) {
      const errMessage =
        `Failed to fetch object with key: ${key} from remote task store: ${error}`;
      logger.critical(
        errMessage,
      );
      reportToSentry(errMessage);
    }
  }

  #getQueuePath(bucket: string) {
    return `${bucket}/queue.json`;
  }

  async #saveQueuesToRemote() {
    for (const [bucket, queue] of this._queues) {
      const serializedQueue = await this.#serializeQueue(queue);
      try {
        await this.#uploadToS3(serializedQueue, this.#getQueuePath(bucket));
        logger.info("Saved task queue to remote storage");
      } catch (error) {
        const errMessage =
          `Failed to save task queue to remote storage: ${error}`;
        logger.critical(errMessage);
        reportToSentry(errMessage);
      }
    }
  }

  async #fetchQueueFromRemote(bucket: string) {
    const queueStr = await this.#getObject(this.#getQueuePath(bucket));
    if (queueStr === undefined) {
      logger.info("No task queue found in remote storage");
      logger.info("Creating a new task queue");
      this.#saveQueuesToRemote();
      return;
    }

    const remoteQueue = await this.#deserializeQueue(queueStr, bucket);
    return remoteQueue;
  }

  async #saveLocksToRemote() {
    const serializedLock = this.#serailizeLocks();
    try {
      await this.#uploadToS3(serializedLock, "storage_locks.json");
      logger.info("Saved locks to remote storage");
    } catch (error) {
      const errMessage = `Failed to save locks to remote storage: ${error}`;
      logger.critical(errMessage);
      reportToSentry(errMessage);
    }
  }

  async #fetchLocksFromRemote() {
    const lockStr = await this.#getObject("storage_locks.json");
    if (lockStr === undefined) {
      logger.info("No locks found in remote storage");
      logger.info("Creating a new lock map");
      this.#saveLocksToRemote();
      return;
    }

    const locks = this.#deserializeLocks(lockStr);
    if (isOk(locks)) {
      return unwrapOk(locks);
    }
  }

  /**
   * Synchronizes the current task queue state to the remote server.
   * This method ensures that both the locks and the queue are saved to the remote server.
   *
   * @returns {Promise<void>} A promise that resolves when the synchronization is complete.
   */
  async syncToRemote() {
    await this.#saveLocksToRemote();
    await this.#saveQueuesToRemote();
  }

  async #syncQueueFromRemote() {
    const queues: [string, Deno.Kv][] = [];
    for (const bucket of this.buckets) {
      const fetchedQueue = await this.#fetchQueueFromRemote(
        bucket,
      );
      if (fetchedQueue === undefined) {
        const errMessage = `Failed to fetch task queue from remote storage`;
        logger.critical(errMessage);
        reportToSentry(errMessage);
        return;
      }
    }

    logger.info(`Fetched task queues from remote storage ${name}`);
    this._queues = queues;
  }

  async #syncLockFromRemote() {
    const fetchedLock = await this.#fetchLocksFromRemote();
    if (fetchedLock === undefined) {
      const errMessage = `Failed to fetch storage locks from remote storage`;
      logger.critical(errMessage);
      reportToSentry(errMessage);
      return;
    }

    logger.info(`Fetched storage locks from remote storage ${name}`);
    this._lockedStorages = fetchedLock;
  }

  async #syncFromRemote() {
    await this.#syncQueueFromRemote();
    await this.#syncLockFromRemote();
  }

  #getDbName(bucket: string) {
    return `${bucket}_${TASK_QUEUE_DB}`;
  }

  get lockedStorages() {
    return this._lockedStorages;
  }
}

export const initTaskStore = async (
  config: GlobalConfig,
  keystoneStore: KeystoneTokenStore,
) => {
  const taskStore = await TaskStore.getInstance(
    Object.keys(config.buckets),
    keystoneStore,
  );
  // update the remote task queue store every 5 minutes
  setInterval(async () => {
    await taskStore.syncToRemote();
  }, 5 * 60 * 1000); // 5 minutes in milliseconds

  return taskStore;
};
