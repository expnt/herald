import { initKeystoneStore } from "./backends/swift/keystone_token_store.ts";
import { Context, Hono } from "@hono/hono";
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

// Centralized CORS helpers
function isOriginAllowed(
  requestOrigin: string | null | undefined,
): string | null {
  if (!requestOrigin || requestOrigin.length === 0) return "*";

  const allowed = globalConfig.cors.host;
  const allowedList = Array.isArray(allowed) ? allowed : [allowed];

  // If no hosts are configured or empty string, deny all origins
  if (
    allowedList.length === 0 ||
    (allowedList.length === 1 && allowedList[0] === "")
  ) {
    return null;
  }

  if (allowedList.includes("*")) return requestOrigin;

  try {
    const url = new URL(requestOrigin);
    const originHost = url.host;
    const originProtocol = url.protocol;

    for (const entry of allowedList) {
      if (entry.startsWith("http://") || entry.startsWith("https://")) {
        if (requestOrigin === entry) return requestOrigin;
        continue;
      }

      const pattern = entry.replace(/^\*\./, ".*");
      const regex = new RegExp(`^${pattern.replace(/\./g, "\\.")}$`, "i");
      if (regex.test(originHost)) return `${originProtocol}//${originHost}`;
    }
  } catch {
    return null;
  }
  return null;
}

function applyCors(c: Context, res: Response): Response {
  const requestOrigin = c.req.header("Origin");
  const allowedOrigin = isOriginAllowed(requestOrigin);
  const headers = new Headers(res.headers);

  if (allowedOrigin === "*") {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
  }

  // Expose S3-relevant headers for browser clients (presigned URL flows)
  headers.set(
    "Access-Control-Expose-Headers",
    [
      "ETag",
      "Content-Length",
      "Content-Type",
      "x-amz-request-id",
      "x-amz-id-2",
      "x-amz-version-id",
      "x-amz-delete-marker",
      "x-amz-expiration",
      "x-amz-server-side-encryption",
      "x-amz-storage-class",
      "x-amz-website-redirect-location",
    ].join(", "),
  );

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

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

    return applyCors(c, c.text(healthStatus, 200));
  }

  // Handle CORS preflight requests (reflect headers when provided; include Vary)
  if (c.req.method === "OPTIONS") {
    const requestOrigin = c.req.header("Origin");
    const allowedOrigin = isOriginAllowed(requestOrigin);
    const reqHeaders = c.req.header("Access-Control-Request-Headers");

    const headers = new Headers();
    if (allowedOrigin === "*") {
      headers.set("Access-Control-Allow-Origin", "*");
    } else if (allowedOrigin) {
      headers.set("Access-Control-Allow-Origin", allowedOrigin);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.append("Vary", "Origin");
    }

    // Keep a stable allow list for tests and browsers
    headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, HEAD, OPTIONS",
    );

    // Allow all x-amz* headers explicitly while reflecting requested ones
    const defaultAllowed = [
      "Content-Type",
      "Authorization",
      "X-Amz-Content-Sha256",
      "X-Amz-Date",
      "X-Amz-Security-Token",
      "X-Amz-User-Agent",
      "X-Amz-Target",
      "X-Amz-Version",
      "X-Amz-Authorization",
    ];
    if (reqHeaders && reqHeaders.length > 0) {
      headers.set(
        "Access-Control-Allow-Headers",
        `${reqHeaders}, ${defaultAllowed.join(", ")}`,
      );
      headers.append("Vary", "Access-Control-Request-Headers");
    } else {
      headers.set("Access-Control-Allow-Headers", defaultAllowed.join(", "));
    }

    headers.set("Access-Control-Max-Age", "86400");

    return new Response("", { status: 200, headers });
  }

  const token = c.req.header("Authorization") ?? null;

  const auth = getAuthType();
  const serviceAccountName = auth === "service_account"
    ? await verifyServiceAccountToken(
      token,
    )
    : "none";

  const response = await resolveHandler(reqCtx, c, serviceAccountName);

  // Add CORS headers to all responses
  return applyCors(c, response);
});

app.notFound((c) => {
  const errMessage = `Resource not found: ${c.req.url}`;
  reportToSentry(errMessage);
  return applyCors(c, c.text("Not Found", 404));
});

app.onError((err, c) => {
  if (err instanceof HeraldError) {
    const errResponse = err.getResponse();
    return applyCors(c, errResponse);
  }

  const errMessage = `Something went wrong in the proxy: ${err.message}`;
  reportToSentry(errMessage);
  return applyCors(
    c,
    InternalServerErrorException(
      c.req.header("x-request-id") ?? "unknown",
    ),
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
