import { getLogger, setupLoggers } from "../utils/log.ts";
import { processTask } from "./mirror.ts";
import { MirrorableCommands, MirrorTask } from "./types.ts";
import { configInit, S3Config } from "../config/mod.ts";
import { inWorker, loggerUtils } from "../utils/mod.ts";
import { HeraldContext } from "../types/mod.ts";
import { TASK_QUEUE_DB } from "../constants/message.ts";
import { TASK_TIMEOUT } from "../constants/time.ts";
import { Bucket } from "../buckets/mod.ts";
import { SwiftConfig } from "../config/types.ts";
import { KeystoneTokenStore } from "./swift/keystone_token_store.ts";

if (inWorker()) {
  await configInit();
  setupLoggers();
}

interface MirrorTaskMessage {
  mainBucketConfig: {
    _name: string;
    _config: S3Config | SwiftConfig;
    replicas: object[];
    _typ: string;
    _backend: string;
  };
  backupBucketConfig: {
    _name: string;
    _config: S3Config | SwiftConfig;
    replicas: object[];
    _typ: string;
    _backend: string;
  };
  command: MirrorableCommands;
  originalRequest: Record<string, unknown>;
  nonce: string;
  retryCount: number;
}

function convertMessageToTask(
  msg: MirrorTaskMessage,
): MirrorTask {
  return {
    mainBucketConfig: Bucket.fromJSON(msg.mainBucketConfig),
    backupBucketConfig: Bucket.fromJSON(msg.backupBucketConfig),
    command: msg.command,
    originalRequest: msg.originalRequest,
    nonce: msg.nonce,
    retryCount: msg.retryCount,
  };
}

interface SerializedSwiftAuthMeta {
  configAuthMetas: [string, object][];
  configs: object[];
}

function prepareWorkerContext(
  ctx: HeraldContext,
  serialized: SerializedSwiftAuthMeta,
) {
  const keystoneStore = KeystoneTokenStore.fromSerializable(serialized);
  ctx.keystoneStore = keystoneStore;

  return ctx;
}

interface UpdateContextMessage {
  ctx: HeraldContext;
  serializedSwiftAuthMeta: SerializedSwiftAuthMeta;
  type: "UpdateContext";
}

interface StartMessage {
  ctx: HeraldContext;
  serializedSwiftAuthMeta: SerializedSwiftAuthMeta;
  type: "Start";
}

let ctx: HeraldContext;

self.postMessage(`Worker started ${self.name}`);
self.onmessage = onMsg;

async function onMsg(event: MessageEvent) {
  const message = event.data;
  const logger = getLogger(import.meta);

  logger.info(`Handling message on worker of type: ${message.type}`);

  switch (message.type) {
    case "UpdateContext":
      onUpdateContext(event, logger);
      break;
    case "Start":
      await onStart(event, logger);
      break;
    default:
      // logically unreachable
      throw new Error("Unknown message type:", message.type);
  }
}

function onUpdateContext(
  msg: MessageEvent<UpdateContextMessage>,
  logger: loggerUtils.Logger,
) {
  ctx = prepareWorkerContext(msg.data.ctx, msg.data.serializedSwiftAuthMeta);
  logger.info("Updated worker's herald context");
}

async function onStart(
  msg: MessageEvent<StartMessage>,
  logger: loggerUtils.Logger,
) {
  logger.info(`Worker started listening to tasks for bucket: ${name}`);

  // TODO: first process any saved current stuck task before going to next tasks
  // after fetching the stuck task from persistent storage
  // this is usually when herald restarts after some crash

  ctx = prepareWorkerContext(msg.data.ctx, msg.data.serializedSwiftAuthMeta);
  const dbName = `${name}_${TASK_QUEUE_DB}`;
  const kv = await Deno.openKv(dbName);
  kv.listenQueue(async (item: MirrorTaskMessage) => {
    const task = convertMessageToTask(item);
    logger.info(`Dequeued task: ${task.command}`);

    try {
      const timeoutPromise: Promise<Error> = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Task timeout")), TASK_TIMEOUT);
      });

      let res = await Promise.race([
        // request task if this fails
        processTask(ctx, task),
        timeoutPromise,
      ]);

      // if the task failed, retry after a while
      while (res instanceof Error || res.status >= 400) {
        // Calculate exponential backoff delay: 2^retryCount * 1000ms (starting at 1s)
        const retryCount = task.retryCount;
        const delay = Math.min(Math.pow(2, retryCount) * 1000, 60000); // Max 60s delay

        // Update retry count and enqueue with delay
        task.retryCount = retryCount + 1;
        logger.critical(
          `Task failed, retrying in ${delay}ms (attempt ${retryCount + 1})`,
        );

        // Wait for the delay before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));

        // TODO: save the task data in persistent storage
        res = await Promise.race([
          // request task if this fails
          processTask(ctx, task),
          timeoutPromise,
        ]);
      }

      logger.info(`Task completed: ${task.command}`);
    } catch (error) {
      logger.error(`Task failed: ${(error as Error).message}`);
    }
  });
}
