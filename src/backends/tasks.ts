import { globalConfig } from "../config/mod.ts";
import { getLogger } from "../utils/log.ts";
import { getBucketFromTask } from "./mirror.ts";
import { kv } from "./task_store.ts";
import { MirrorTask } from "./types.ts";

const logger = getLogger(import.meta);

async function setupWorkers() {
  const buckets = Object.keys(globalConfig.buckets);
  const workers = new Map<string, Worker>();
  for (const bucket of buckets) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url).href, {
      type: "module",
      name: `bucket ${bucket} kv worker`,
    });
    await new Promise((resolve, reject) => {
      worker.onmessage = (evt: MessageEvent<string>) => {
        const res = evt.data;
        logger.info(res);
        resolve(res);
      };
      worker.onmessageerror = (evt) => {
        reject(evt.data);
      };
      worker.onerror = (err) => {
        reject(err);
      };
    });
    workers.set(bucket, worker);
  }

  return workers;
}

const workers = await setupWorkers();

export function taskHandler() {
  kv.listenQueue(async (task: MirrorTask) => {
    logger.info(`Dequeued task: ${task.command}`);

    const taskBucket = getBucketFromTask(task);
    const worker = workers.get(taskBucket);
    if (!worker) {
      logger.info(`Worker for bucket ${taskBucket} busy`);
      logger.info(
        `Re-enqueueing task: ${task.command} to process when worker is available`,
      );
      setTimeout(() => {
        kv.enqueue(task);
      }, 1000);
      return;
    }
    workers.delete(taskBucket);

    worker.postMessage(task);
    await new Promise((resolve, reject) => {
      worker.onmessage = (evt: MessageEvent<string>) => {
        const res = evt.data;
        if (res === "Task completed") {
          workers.set(taskBucket, worker);
          logger.info(`Task completed: ${task.command}`);
        }
        resolve(res);
      };
      worker.onmessageerror = (evt) => {
        reject(evt.data);
      };
      worker.onerror = (err) => {
        reject(err);
      };
    });
  });
}

taskHandler();
