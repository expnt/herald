import { globalConfig } from "../config/mod.ts";
import { HeraldContext } from "../types/mod.ts";
import { getLogger } from "../utils/log.ts";

const logger = getLogger(import.meta);

async function createNewWorker(bucket: string) {
  const worker = new Worker(new URL("./worker.ts", import.meta.url).href, {
    type: "module",
    name: bucket,
  });
  // Hack to get around the fact that the worker is not yet ready to receive messages
  const workerCreation = () => {
    return new Promise((resolve, reject) => {
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
  };
  await workerCreation();
  return worker;
}

async function setupWorkers() {
  const buckets = Object.keys(globalConfig.buckets);
  const workers = new Map<string, Worker>();
  for (const bucket of buckets) {
    const worker = await createNewWorker(bucket);
    workers.set(bucket, worker);
  }

  return workers;
}

let workers: Map<string, Worker>;

export function startWorkers(ctx: HeraldContext) {
  for (const [_, worker] of workers) {
    worker.postMessage({
      ctx: JSON.parse(JSON.stringify(ctx)),
      type: "Start",
    });
  }
}

export function refreshWorkersContext(ctx: HeraldContext) {
  for (const [_, worker] of workers) {
    worker.postMessage({
      ctx: JSON.parse(JSON.stringify(ctx)),
      type: "UpdateContext",
    });
  }
}

export async function initializeTaskHandler(ctx: HeraldContext) {
  workers = await setupWorkers();
  startWorkers(ctx);
}
