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

  ctx = prepareWorkerContext(msg.data.ctx, msg.data.serializedSwiftAuthMeta);
  const dbName = `${name}_${TASK_QUEUE_DB}`;
  const kv = await Deno.openKv(dbName);
  kv.listenQueue(async (item: MirrorTaskMessage) => {
    const task = convertMessageToTask(item);
    logger.info(`Dequeued task: ${task.command}`);

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Task timeout")), TASK_TIMEOUT);
      });

      const _ = await Promise.race([
        processTask(ctx, task),
        timeoutPromise,
      ]);

      logger.info(`Task completed: ${task.command}`);
    } catch (error) {
      logger.error(`Task failed: ${(error as Error).message}`);
    }
  });
}
