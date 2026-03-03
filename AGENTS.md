- We're using the effects library https://effect.website/llms.txt
  - Their HTTP implementation is described in ./HTTP_PLATFORM.md
  - **ALWAYS** use `@effect/platform/HttpClient` instead of native `fetch` for
    all HTTP requests.
  - Prefer generators over effect piping.
  - Use methods on `Effect.Option` like `Option.isNone` instead of looking at
    `_tag`.
  - **NEVER** use standard `try/catch` or `try/finally` blocks around `yield*`
    in Effect generators. Use `Effect.addFinalizer`, `Effect.try`,
    `Effect.catchAll`, or `Effect.orElse`.
  - **ALWAYS** use the `Config` module from Effect for environment variable
    access instead of `Deno.env.get`.
- **NEVER** assume default values using `??` or ternary operators for critical
  configuration or external input (e.g., `bucket.region ?? "us-east-1"`,
  `request.headers.host ?? "localhost"`). Always fail explicitly with a
  descriptive error.
- Use `Effect.fail` or `Effect.die` instead of returning "unknown" or empty
  strings when expected data is missing.
- When mapping external errors (like S3 SDK exceptions), be as specific as
  possible. Avoid generic "Unknown" or "S3 error" messages.

- Reference ./symlinks/herald, ./symlinks/s3proxy and ./symlinks/s3-tests for S3
  behavior and other S3 proxy imps.
- Reference ./symlinks/ghjk for Deno typescript conventions especially
  ./symlinks/ghjk/tests/.
- Reference ./symlinks/sample-http for how to do some things using the Effect
  library.

- Prefer to preserve comments unless they are progress comments written by an
  agent.
- Maintain strict type safety. Avoid "any" casts or requirement hacks.
- Use the structured `Logger` layer for all diagnostic output.

- Always fix deno lint and deno check issues before running tests, the type
  system is there to help.
- Never use `--no-check`. Treat the codebase like a Rust codebase. Live and die
  by the type system.
