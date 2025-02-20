import type { StatusCode } from "../utils/http-status.ts";

type HTTPExceptionOptions = {
  res?: Response;
  message?: string;
  cause?: unknown;
};

/**
 * `HTTPException` must be used when a fatal error such as authentication failure occurs.
 * @example
 * ```ts
 * import { HTTPException } from 'hono/http-exception'
 *
 * // ...
 *
 * app.post('/auth', async (c, next) => {
 *   // authentication
 *   if (authorized === false) {
 *     throw new HTTPException(401, { message: 'Custom error message' })
 *   }
 *   await next()
 * })
 * ```
 * @see https://hono.dev/api/exception
 */
export class HTTPException extends Error {
  readonly res?: Response;
  readonly status: StatusCode | number;

  constructor(status: number = 500, options?: HTTPExceptionOptions) {
    super(options?.message, { cause: options?.cause });
    this.res = options?.res;
    this.status = status;
  }

  getResponse(): Response {
    if (this.res) {
      const newResponse = new Response(this.res.body, {
        status: this.res.status,
        headers: this.res.headers,
      });
      return newResponse;
    }
    return new Response(this.message, {
      status: this.status,
    });
  }
}
