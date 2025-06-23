import { getLogger, reportToSentry } from "../utils/log.ts";
import { MirrorTask } from "./types.ts";
import { GlobalConfig } from "../config/types.ts";
import { TASK_QUEUE_DB } from "../constants/message.ts";
import { Result } from "option-t/plain_result";
import { RequestContext } from "../types/mod.ts";
import {
  getObject as swiftGetObject,
  putObject as swiftPutObject,
} from "./swift/objects.ts";
import { Bucket } from "../buckets/mod.ts";
import {
  getObject as s3GetObject,
  putObject as s3PutObject,
} from "./s3/objects.ts";
import { getBucket } from "../config/loader.ts";

const logger = getLogger(import.meta);

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

  #deserializeLocks(queueString: string): Map<string, number> {
    const locks = JSON.parse(queueString);
    const newLocks = new Map<string, number>(locks);

    return newLocks;
  }

  async #uploadToS3(_body: string, _key: string) {
    // const uploadCommand = new PutObjectCommand({
    //   Bucket: "task-store",
    //   Body: body,
    //   Key: key,
    // });
    // try {
    //   await this.s3.send(uploadCommand);
    // } catch (error) {
    //   const errMesage =
    //     `Failed to upload object with key: ${key} to remote store: ${error}`;
    //   logger.critical(
    //     errMesage,
    //   );
    //   reportToSentry(errMesage);
    // }
  }

  async #getObject(key: string) {
    // Instead of using the SDK, manually construct the HTTP request for S3 GetObject
    const bucket = "task-store";
    const objectKey = key;

    // Construct the S3 GetObject URL (assuming AWS S3, adjust endpoint as needed)
    // This assumes the region and endpoint are available as this.s3Endpoint and this.s3Region
    // and credentials as this.s3AccessKeyId and this.s3SecretAccessKey
    // You may need to adjust these based on your environment/config

    // Example: https://{bucket}.s3.{region}.amazonaws.com/{key}
    const s3Url = `https://${bucket}.s3.amazonaws.com/${
      encodeURIComponent(objectKey)
    }`;

    // Prepare headers (add authentication if needed)
    const headers: Record<string, string> = {
      // Add any required headers here, e.g., for authentication
      // For public buckets, this may be empty
    };

    try {
      const response = await fetch(s3Url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        const errMessage =
          `Failed to fetch object with key: ${key} from remote task store (HTTP ${response.status})`;
        logger.critical(
          errMessage,
        );
        reportToSentry(errMessage);
      }

      if (!response.body) {
        const errMessage =
          `Failed to read the body of ${key} from remote task store`;
        logger.critical(
          errMessage,
        );
        reportToSentry(errMessage);
      }

      if (response.body) {
        const reader = response.body.getReader();
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
    return locks;
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

export const initTaskStore = async (config: GlobalConfig) => {
  const taskStore = await TaskStore.getInstance(
    Object.keys(config.buckets),
  );
  // update the remote task queue store every 5 minutes
  setInterval(async () => {
    await taskStore.syncToRemote();
  }, 5 * 60 * 1000); // 5 minutes in milliseconds

  return taskStore;
};
