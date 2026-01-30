import { HttpMiddleware, HttpServerRequest } from "@effect/platform";
import { Duration, Effect, Metric, pipe } from "effect";

/** HTTP request count by method and status class. Low cardinality. */
export const heraldHttpRequestsTotal = Metric.counter(
  "herald_http_requests_total",
  { description: "Total HTTP requests" },
);

/** HTTP request duration in milliseconds. */
export const heraldHttpRequestDurationMs = Metric.timer(
  "herald_http_request_duration_ms",
  "Request duration in milliseconds",
);

function statusClass(status: number): string {
  if (status >= 100 && status < 200) return "1xx";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500) return "5xx";
  return "unknown";
}

/**
 * Middleware that records herald_http_requests_total (method, status_class) and
 * herald_http_request_duration_ms for every request. Single place, DRY.
 */
export const heraldHttpMetricsMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const start = Date.now();
    const response = yield* app;
    const status = response.status ?? 0;
    const statusClassTag = statusClass(status);
    const method = request.method ?? "UNKNOWN";
    const taggedCounter = pipe(
      heraldHttpRequestsTotal,
      Metric.tagged("method", method),
      Metric.tagged("status_class", statusClassTag),
    );
    yield* Metric.increment(taggedCounter);
    yield* Metric.update(
      heraldHttpRequestDurationMs,
      Duration.millis(Date.now() - start),
    );
    return response;
  })
);
