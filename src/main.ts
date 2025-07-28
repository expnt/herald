import { initKeystoneStore } from "./backends/swift/keystone_token_store.ts";
import { Hono } from "@hono/hono";
import { configInit, envVarsConfig, globalConfig } from "./config/mod.ts";
import { getLogger, reportToSentry, setupLoggers } from "./utils/log.ts";
import { resolveHandler } from "./backends/mod.ts";
import { HeraldError } from "./types/http-exception.ts";
import * as Sentry from "sentry";
import { getAuthType, verifyServiceAccountToken } from "./auth/mod.ts";
import { registerWorkers } from "./workers/mod.ts";
import { registerSignalHandlers } from "./utils/signal_handlers.ts";
import { HeraldContext, RequestContext } from "./types/mod.ts";
import { initTaskStore } from "./backends/task_store.ts";
import { InternalServerErrorException } from "./constants/errors.ts";
import { getRandomUUID } from "./utils/crypto.ts";

// setup
await configInit();
setupLoggers();
const logger = getLogger(import.meta);

// Sentry setup
Sentry.init({
  dsn: envVarsConfig.sentry_dsn,
  release: envVarsConfig.version,
  environment: envVarsConfig.env === "DEV" ? "development" : "production",
  sampleRate: envVarsConfig.sentry_sample_rate,
  tracesSampleRate: envVarsConfig.sentry_traces_sample_rate,
  // integrations: [
  //   new Sentry.Integrations.Context({
  //     app: true,
  //     os: true,
  //     device: true,
  //     culture: true,
  //   }),
  // ],
  debug: true,
});
self.addEventListener("error", (event: ErrorEvent) => {
  Sentry.captureException(event.error);
});

self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  Sentry.captureException(event.reason);
});

const keystoneTokenStore = await initKeystoneStore(globalConfig);
const ctx: HeraldContext = {
  taskStore: await initTaskStore(globalConfig, keystoneTokenStore),
  keystoneStore: keystoneTokenStore,
};

const app = new Hono();

app.all("/*", async (c) => {
  const reqId = getRandomUUID();
  const reqLogger = getLogger(import.meta, reqId);
  const reqCtx: RequestContext = {
    logger: reqLogger,
    heraldContext: ctx,
  };

  const path = c.req.path;
  let logMsg = `Receieved request on ${c.req.url}`;
  reqLogger.debug(logMsg);

  if (path === "/health-check") {
    // TODO: thorough health check,
    const healthStatus = "Ok";
    logMsg = `Health Check Complete: ${healthStatus}`;

    reqLogger.info(logMsg);
    return c.text(healthStatus, 200);
  }

  const token = c.req.header("Authorization") ?? null;

  const auth = getAuthType();
  const serviceAccountName = auth === "service_account"
    ? await verifyServiceAccountToken(
      token,
    )
    : "none";

  const response = await resolveHandler(reqCtx, c, serviceAccountName);
  return response;
});

app.notFound((c) => {
  const errMessage = `Resource not found: ${c.req.url}`;
  // logger.warn(errMessage);
  reportToSentry(errMessage);
  return c.text("Not Found", 404);
});

app.onError((err, c) => {
  if (err instanceof HeraldError) {
    // Get the custom response
    const errResponse = err.getResponse();

    return errResponse;
  }

  const errMessage = `Something went wrong in the proxy: ${err.message}`;
  // logger.error(errMessage);
  reportToSentry(errMessage);
  return InternalServerErrorException(
    c.req.header("x-request-id") ?? "unknown",
  );
});

registerSignalHandlers(ctx);
await registerWorkers(ctx);

const controller = new AbortController();
const { signal } = controller;

export default {
  fetch: app.fetch,
  port: globalConfig.port,
  signal,
  // You can also add an error handler for the server itself
  onError: (error: Error) => {
    if ((error as Error).name === "AbortError") {
      logger.info("Server shut down gracefully");
    } else {
      throw error;
    }
  },
};
