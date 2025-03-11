import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { getLogger, reportToSentry } from "../utils/log.ts";
import { MirrorTask } from "./types.ts";
import { S3Config } from "../config/mod.ts";
import { GlobalConfig } from "../config/types.ts";
import { TASK_QUEUE_DB } from "../constants/message.ts";

const logger = getLogger(import.meta);

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
    remoteStorageConfig: S3Config,
    buckets: string[],
  ): Promise<TaskStore> {
    async function inner() {
      const s3 = new S3Client(remoteStorageConfig);
      const taskQueues: [string, Deno.Kv][] = [];
      for (const bucket of buckets) {
        const kv = await Deno.openKv(`${bucket}_${TASK_QUEUE_DB}`);
        taskQueues.push([bucket, kv]);
      }
      const lockedStorages = new Map<string, number>();

      const newInstance = new TaskStore(
        s3,
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
    private s3: S3Client,
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

  async #uploadToS3(body: string, key: string) {
    const uploadCommand = new PutObjectCommand({
      Bucket: "task-store",
      Body: body,
      Key: key,
    });
    try {
      await this.s3.send(uploadCommand);
    } catch (error) {
      const errMesage =
        `Failed to upload object with key: ${key} to remote store: ${error}`;
      logger.critical(
        errMesage,
      );
      reportToSentry(errMesage);
    }
  }

  async #getObject(key: string) {
    const headObject = new HeadObjectCommand({
      Bucket: "task-store",
      Key: key,
    });

    try {
      const _ = await this.s3.send(headObject);
    } catch (error) {
      const errMessage =
        `Object with key: ${key} doesn't exist in task store: ${error}`;
      logger.warn(
        errMessage,
      );
      reportToSentry(errMessage);
      return;
    }

    const getCommand = new GetObjectCommand({
      Bucket: "task-store",
      Key: key,
    });

    try {
      const response = await this.s3.send(getCommand);
      if (!response || response.$metadata.httpStatusCode !== 200) {
        const errMessage =
          `Failed to fetch object with key: ${key} from remote task store`;
        logger.critical(
          errMessage,
        );
        reportToSentry(errMessage);
      }

      if (!response.Body) {
        const errMessage =
          `Failed to read the body of ${key} from remote task store`;
        logger.critical(
          errMessage,
        );
        reportToSentry(errMessage);
      }

      return await response.Body?.transformToString();
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
    config.task_store_backend,
    Object.keys(config.buckets),
  );
  // update the remote task queue store every 5 minutes
  setInterval(async () => {
    await taskStore.syncToRemote();
  }, 5 * 60 * 1000); // 5 minutes in milliseconds

  return taskStore;
};
