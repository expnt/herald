import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { getLogger, reportToSentry } from "../utils/log.ts";
import { MirrorTask } from "./types.ts";
import { loadConfig } from "../config/loader.ts";
import { S3Config } from "../config/mod.ts";

const logger = getLogger(import.meta);

export class TaskStore {
  private static instance: Promise<TaskStore> | null = null;

  public static getInstance(
    remoteStorageConfig: S3Config,
  ): Promise<TaskStore> {
    async function inner() {
      const s3 = new S3Client(remoteStorageConfig);
      const queue = await Deno.openKv();
      const lockedStorages = new Map<string, number>();

      const newInstance = new TaskStore(s3, queue, lockedStorages);
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
    private _queue: Deno.Kv,
    private _lockedStorages: Map<string, number>,
  ) {}

  async #serializeQueue() {
    const entries = [];
    // Iterate over all entries in the store
    for await (const entry of this._queue.list({ prefix: [] })) {
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

  async #deserializeQueue(queueString: string): Promise<Deno.Kv> {
    const entries = JSON.parse(queueString);
    const newQueue = await Deno.openKv();

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

  async #saveQueueToRemote() {
    const serializedQueue = await this.#serializeQueue();
    try {
      await this.#uploadToS3(serializedQueue, "queue.json");
      logger.info("Saved task queue to remote storage");
    } catch (error) {
      const errMessage =
        `Failed to save task queue to remote storage: ${error}`;
      logger.critical(errMessage);
      reportToSentry(errMessage);
    }
  }

  async #fetchQueueFromRemote() {
    const queueStr = await this.#getObject("queue.json");
    if (queueStr === undefined) {
      logger.info("No task queue found in remote storage");
      logger.info("Creating a new task queue");
      this.#saveQueueToRemote();
      return;
    }

    const remoteQueue = await this.#deserializeQueue(queueStr);
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

  async syncToRemote() {
    await this.#saveLocksToRemote();
    await this.#saveQueueToRemote();
  }

  async #syncQueueFromRemote() {
    const fetchedQueue = await this.#fetchQueueFromRemote();
    if (fetchedQueue === undefined) {
      const errMessage = `Failed to fetch task queue from remote storage`;
      logger.critical(errMessage);
      reportToSentry(errMessage);
      return;
    }

    logger.info(`Fetched task queue from remote storage ${name}`);
    this._queue = fetchedQueue;
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

  get queue() {
    return this._queue;
  }

  get lockedStorages() {
    return this._lockedStorages;
  }
}

// Use this to get the single instance
const config = await loadConfig();
const taskStore = await TaskStore.getInstance(config.task_store_backend);
export const kv = taskStore.queue;
export const lockedStorages = taskStore.lockedStorages;
export default taskStore;