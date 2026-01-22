#!/usr/bin/env -S deno run --allow-all
/**
 * Herald S3 Compatibility Test Runner
 *
 * This script runs the Ceph S3 compatibility test suite (s3-tests) against
 * a local Herald proxy instance. It handles:
 *  - Starting the Herald proxy with a specified backend (minio or swift)
 *  - Configuring s3-tests to point to the proxy
 *  - Running pytest with real-time output streaming
 *  - Parsing JUnit XML for a final summary
 *
 * Usage:
 *   ./x/s3-tests.ts [pytest-args] [--backend <minio|swift>] [--no-abort]
 *
 * Environment Variables:
 *   S3TEST_TAGS: Custom pytest marks (default: not buckets and ...)
 *   S3TEST_PYTEST_ARGS: Additional pytest arguments
 *   S3TEST_NO_ABORT: Set to "true" to disable abort-on-error
 *   HERALD_LOG_LEVEL: Set to "DEBUG" for verbose proxy logging
 *
 * Files:
 *   s3-tests/s3tests.conf: Generated s3-tests configuration
 *   s3-tests/herald-proxy.log: Herald proxy logs (minio backend)
 *   s3-tests/herald-proxy-swift.log: Herald proxy logs (swift backend)
 *   s3-tests/s3-tests.log: Full pytest output
 */

import { Config, Effect, Logger, LogLevel, Option } from "effect";
import * as path from "@std/path";
import { $ } from "@david/dax";
import * as colors from "@std/fmt/colors";
import { makeTestHarness } from "../tests/utils.ts";
import { GlobalConfig } from "../src/Domain/Config.ts";

const DEFAULT_TAGS =
  "not appendobject and not bucket_policy and not copy and not cors and not encryption and not fails_strict_rfc2616 and not iam_tenant and not lifecycle and not object_lock and not policy and not policy_status and not s3select and not s3website and not sse_s3 and not tagging and not test_of_sts and not user_policy and not versioning and not webidentity_test";

function getMinioConfig(): GlobalConfig {
  return {
    backends: {
      minio: {
        protocol: "s3",
        endpoint: "http://localhost:9000",
        region: "us-east-1",
        credentials: {
          accessKeyId: "minioadmin",
          secretAccessKey: "minioadmin",
        },
        buckets: "*",
      },
    },
  };
}

const getSwiftConfig = () =>
  Effect.gen(function* () {
    const authUrl = yield* Config.string("HERALD_SWIFTTEST_AUTH_URL").pipe(
      Config.orElse(() => Config.string("OS_AUTH_URL")),
      Config.withDefault("http://localhost:8080/auth/v1.0"),
      Config.option,
    );

    const username = yield* Config.string("HERALD_SWIFTTEST_OS_USERNAME").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_USERNAME")),
      Config.orElse(() => Config.string("OS_USERNAME")),
      Config.withDefault("test:tester"),
      Config.option,
    );
    const password = yield* Config.string("HERALD_SWIFTTEST_OS_PASSWORD").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_PASSWORD")),
      Config.orElse(() => Config.string("OS_PASSWORD")),
      Config.withDefault("testing"),
      Config.option,
    );
    const projectName = yield* Config.string("HERALD_SWIFTTEST_OS_PROJECT_NAME")
      .pipe(
        Config.orElse(() => Config.string("TF_VAR_OS_PROJECT_NAME")),
        Config.orElse(() => Config.string("OS_PROJECT_NAME")),
        Config.option,
      );
    const region = yield* Config.string("HERALD_SWIFTTEST_OS_REGION_NAME").pipe(
      Config.orElse(() => Config.string("TF_VAR_OS_REGION_NAME")),
      Config.orElse(() => Config.string("OS_REGION_NAME")),
      Config.withDefault("dc3-a"),
      Config.option,
    );

    if (
      Option.isNone(username) || Option.isNone(password) ||
      Option.isNone(authUrl)
    ) {
      return Option.none();
    }

    const config: GlobalConfig = {
      backends: {
        swift: {
          protocol: "swift",
          auth_url: authUrl.value,
          region: Option.getOrUndefined(region),
          credentials: {
            username: username.value,
            password: password.value,
            project_name: Option.getOrUndefined(projectName),
            user_domain_name: "Default",
            project_domain_name: "Default",
          },
          buckets: "*",
        },
      },
    };
    return Option.some(config);
  });

const program = Effect.gen(function* () {
  console.log("Program started");
  const __dirname = path.dirname(path.fromFileUrl(import.meta.url));
  const s3TestsDir = path.resolve(__dirname, "../s3-tests");

  // Parse filtering arguments and flags
  const rawArgs = [...Deno.args];
  const noAbort = rawArgs.includes("--no-abort") ||
    Deno.env.get("S3TEST_NO_ABORT") === "true";

  let backend = "minio";
  const backendIdx = rawArgs.indexOf("--backend");
  if (backendIdx !== -1) {
    backend = rawArgs[backendIdx + 1];
    rawArgs.splice(backendIdx, 2);
  }

  const pytestArgsFromCli = rawArgs.filter((arg) => arg !== "--no-abort");

  const proxyLogName = backend === "swift"
    ? "herald-proxy-swift.log"
    : "herald-proxy.log";
  const proxyLogPath = path.join(s3TestsDir, proxyLogName);

  // Initialize config based on backend
  let activeConfig: GlobalConfig;
  let s3AccessKey = "minioadmin";
  let s3SecretKey = "minioadmin";

  if (backend === "swift") {
    const swiftConfig = yield* getSwiftConfig();
    if (Option.isNone(swiftConfig)) {
      return yield* Effect.fail(
        new Error("Swift credentials missing. Run with infisical."),
      );
    }
    activeConfig = swiftConfig.value;
    // For Swift backend, Herald doesn't check S3 credentials,
    // but s3-tests needs them to sign requests.
    s3AccessKey = "dummy";
    s3SecretKey = "dummy";
  } else {
    activeConfig = getMinioConfig();
  }

  console.log("Creating file logger for proxy...");
  // Create a file logger for the proxy
  const proxyLogFile = yield* Effect.tryPromise(() =>
    Deno.open(proxyLogPath, { write: true, create: true, truncate: true })
  );

  yield* Effect.addFinalizer(() =>
    Effect.tryPromise({
      try: () => Promise.resolve(proxyLogFile.close()),
      catch: (e) => new Error(`Failed to close proxy log file: ${e}`),
    }).pipe(Effect.orDie)
  );

  const logLevel = yield* Config.string("HERALD_LOG_LEVEL").pipe(
    Config.withDefault("INFO"),
  );
  const minLogLevel = LogLevel.Debug;

  // Create a custom logging layer that writes to file synchronously
  const FileLoggingLive = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message, logLevel: currentLogLevel }) => {
      const timestamp = new Date().toISOString();
      const level = currentLogLevel.label;
      const msg = typeof message === "string" ? message : String(message);
      const logLine = `${timestamp} level=${level} ${msg}\n`;
      try {
        proxyLogFile.writeSync(new TextEncoder().encode(logLine));
      } catch (e) {
        console.error(`Failed to write to proxy log: ${e}`);
      }
    }),
  );

  // Provide the file logger to the test harness (the proxy)
  const h = yield* makeTestHarness(activeConfig, FileLoggingLive);

  const port = new URL(h.proxyUrl).port;

  // Parse remaining filtering arguments
  const tags = Deno.env.get("S3TEST_TAGS") ?? DEFAULT_TAGS;
  const pytestArgsEnv = Deno.env.get("S3TEST_PYTEST_ARGS") ?? "";
  const pytestArgsFromEnv = pytestArgsEnv ? pytestArgsEnv.split(/\s+/) : [];

  const pytestArgs = [...pytestArgsFromEnv, ...pytestArgsFromCli];

  return yield* (Effect.gen(function* () {
    // We use console.log for harness output to avoid them going to the proxy log file
    console.log(
      `Starting Herald (${colors.cyan(backend)} backend) on port ${
        colors.cyan(port)
      }`,
    );
    console.log(`Proxy logs: ${colors.gray(proxyLogPath)}`);

    const confContent = `[DEFAULT]
host = 127.0.0.1
port = ${port}
is_secure = no

[fixtures]
bucket prefix = herald-${backend}-{random}-

[s3 main]
user_id = main
display_name = main
email = main@example.com
access_key = ${s3AccessKey}
secret_key = ${s3SecretKey}

[s3 alt]
user_id = alt
display_name = alt
email = alt@example.com
access_key = ${s3AccessKey}
secret_key = ${s3SecretKey}

[s3 tenant]
user_id = tenant
display_name = tenant
email = tenant@example.com
access_key = ${s3AccessKey}
secret_key = ${s3SecretKey}
tenant = testx

[iam]
email = iam@example.com
user_id = iam
access_key = ${s3AccessKey}
secret_key = ${s3SecretKey}
display_name = iam

[iam root]
access_key = ${s3AccessKey}
secret_key = ${s3SecretKey}
user_id = iam_root
email = iam_root@example.com

[iam alt root]
access_key = ${s3AccessKey}
secret_key = ${s3SecretKey}
user_id = iam_alt_root
email = iam_alt_root@example.com
`;

    const confPath = yield* Effect.promise(() =>
      Deno.makeTempFile({ suffix: ".conf" })
    );
    yield* Effect.promise(() => Deno.writeTextFile(confPath, confContent));

    const logName = backend === "swift" ? "s3-tests-swift.log" : "s3-tests.log";
    const logPath = path.join(s3TestsDir, logName);

    console.log(`s3-tests directory: ${colors.gray(s3TestsDir)}`);
    console.log(`Log file: ${colors.gray(logPath)}`);

    // Ensure we have a virtual environment
    const venvPath = path.join(s3TestsDir, ".venv");
    const venvExists = yield* Effect.tryPromise(() =>
      Deno.stat(venvPath).then(() => true).catch(() => false)
    );

    if (!venvExists) {
      console.log(colors.yellow("Creating Python virtual environment..."));
      yield* Effect.tryPromise(() => $`uv venv --python 3.11`.cwd(s3TestsDir));
    }

    // Register finalizer to clean up conf file
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () =>
          Deno.remove(confPath).catch((e) => {
            console.error(`Failed to remove conf file ${confPath}: ${e}`);
          }),
        catch: (e) => new Error(`Effect.tryPromise failed: ${e}`),
      }).pipe(Effect.orDie)
    );

    // Ensure dependencies are installed
    const pytestCheck = yield* Effect.tryPromise({
      try: async () => {
        const proc = $`uv run pytest --version`.cwd(s3TestsDir).noThrow();
        return await proc;
      },
      catch: () => new Error("Check failed"),
    });

    if (pytestCheck.code !== 0) {
      console.log(colors.yellow("Installing s3-tests dependencies..."));
      yield* Effect.tryPromise({
        try: async () => {
          await $`uv pip install -r requirements.txt`.cwd(s3TestsDir);
          await $`uv pip install -e .`.cwd(s3TestsDir);
        },
        catch: (e) => new Error(`Failed to install dependencies: ${e}`),
      });
    }

    console.log(
      `Running s3-tests against Herald on port ${colors.cyan(port)}...`,
    );
    if (tags) console.log(`${colors.gray("Tags:")} ${tags}`);
    if (pytestArgs.length > 0) {
      console.log(
        `${colors.gray("Additional pytest args:")} ${pytestArgs.join(" ")}`,
      );
    }
    if (noAbort) {
      console.log(colors.yellow("Abort on ERROR disabled (--no-abort)"));
    }

    // Build command arguments
    const cmdArgs = [
      "-v",
      "--tb=short",
    ];

    const junitXmlName = "junit.xml";
    const junitXmlPath = path.join(s3TestsDir, junitXmlName);
    cmdArgs.push(`--junit-xml=${junitXmlName}`);

    if (tags) {
      cmdArgs.push("-m", tags);
    }

    cmdArgs.push(...pytestArgs);

    const logFile = yield* Effect.tryPromise(() =>
      Deno.open(logPath, {
        write: true,
        create: true,
        truncate: true,
      })
    );

    console.log(`Command: uv run pytest ${cmdArgs.join(" ")}`);
    const child = $`uv run pytest ${cmdArgs}`
      .cwd(s3TestsDir)
      .env({ S3TEST_CONF: confPath, PYTHONUNBUFFERED: "1" })
      .stdout("piped")
      .stderr("piped")
      .spawn();

    const sigintHandler = () => {
      child.kill();
      Deno.exit(0);
    };
    Deno.addSignalListener("SIGINT", sigintHandler);

    const result = yield* Effect.tryPromise({
      try: async () => {
        let collectedInfo = "";
        let failedCount = 0;
        let errorCount = 0;
        let skippedCount = 0;
        let lastResultTime = Date.now();
        const seenTests = new Set<string>();
        const failedTests = new Set<string>();
        const errorTests = new Set<string>();
        let currentTestName = "";

        let shouldAbort = false;
        let abortReason = "";

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          // Capture test result lines like:
          // s3tests/functional/test_s3.py::test_bucket_list_empty PASSED [ 0%]
          const resultMatch = trimmed.match(
            /^([^\s]+::[^\s]+)\s+(PASSED|FAILED|ERROR|SKIPPED)/,
          );
          if (resultMatch) {
            const testName = resultMatch[1];
            const status = resultMatch[2];
            const now = Date.now();
            const duration = ((now - lastResultTime) / 1000).toFixed(2);
            lastResultTime = now;
            currentTestName = testName;

            if (status === "PASSED") {
              console.log(
                `${colors.green("✓")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
            } else if (status === "FAILED") {
              if (!seenTests.has(testName)) {
                failedCount++;
                seenTests.add(testName);
                failedTests.add(testName);
              }
              console.error(
                `${colors.red("✗")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
            } else if (status === "ERROR") {
              if (!seenTests.has(testName)) {
                errorCount++;
                seenTests.add(testName);
                errorTests.add(testName);
              }
              console.error(
                `${colors.red("✗ ERROR:")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
              if (!noAbort) {
                shouldAbort = true;
                abortReason = `ERROR in ${testName}`;
                child.kill();
              }
            } else if (status === "SKIPPED") {
              skippedCount++;
              console.log(
                `${colors.yellow("-")} ${testName} ${
                  colors.gray(`(${duration}s)`)
                }`,
              );
            }
            return;
          }

          // Also check for ERROR in non-verbose format
          const errorMatch = trimmed.match(/^ERROR\s+([^\s]+::[^\s]+)/);
          if (errorMatch) {
            const testName = errorMatch[1];
            const now = Date.now();
            const duration = ((now - lastResultTime) / 1000).toFixed(2);
            lastResultTime = now;
            currentTestName = testName;

            if (!seenTests.has(testName)) {
              errorCount++;
              seenTests.add(testName);
              errorTests.add(testName);
            }
            console.error(
              `${colors.red("✗ ERROR:")} ${testName} ${
                colors.gray(`(${duration}s)`)
              }`,
            );

            if (!noAbort) {
              shouldAbort = true;
              abortReason = `ERROR in ${testName}`;
              child.kill();
            }
            return;
          }

          // Echo important lines (failures, tracebacks, summaries)
          if (
            trimmed.includes("FAILURES") ||
            trimmed.includes("ERRORS") ||
            trimmed.includes("short test summary") ||
            trimmed.startsWith("E   ") || // Traceback lines in short format
            trimmed.startsWith(">   ") ||
            trimmed.match(/^=+\s*(passed|failed|error)/i)
          ) {
            const prefix = currentTestName
              ? colors.gray(`[${currentTestName}] `)
              : "";
            console.log(`${prefix}${trimmed}`);
          }
        };

        const decoder = new TextDecoder();

        async function streamToLogAndConsole(
          stream: ReadableStream<Uint8Array>,
        ) {
          const reader = stream.getReader();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              await logFile.write(value);
            } catch (e) {
              console.error(`Failed to write to log file: ${e}`);
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              processLine(line);
            }
          }
          if (buffer) {
            processLine(buffer);
          }
          reader.releaseLock();
        }

        const [procResult] = await Promise.all([
          child,
          streamToLogAndConsole(child.stdout()),
          streamToLogAndConsole(child.stderr()),
        ]);

        Deno.removeSignalListener("SIGINT", sigintHandler);

        // Attempt to parse JUnit XML if it exists and is valid
        let junitData: {
          tests: number;
          failures: number;
          errors: number;
          skipped: number;
          time?: number;
          failedNames: string[];
          errorNames: string[];
        } | null = null;

        try {
          const junitXml = await Deno.readTextFile(junitXmlPath);
          const getAttr = (name: string) => {
            const match = junitXml.match(new RegExp(`${name}="([\\d.]+)"`));
            return match ? parseFloat(match[1]) : 0;
          };

          const failedNames: string[] = [];
          const errorNames: string[] = [];

          const testcaseMatches = junitXml.matchAll(
            /<testcase classname="([^"]+)" name="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/g,
          );
          for (const match of testcaseMatches) {
            const fullName = `${match[1]}::${match[2]}`;
            const content = match[3];
            if (content.includes("<failure")) failedNames.push(fullName);
            if (content.includes("<error")) errorNames.push(fullName);
          }

          junitData = {
            tests: Math.floor(getAttr("tests")),
            failures: Math.floor(getAttr("failures")),
            errors: Math.floor(getAttr("errors")),
            skipped: Math.floor(getAttr("skipped")),
            time: getAttr("time"),
            failedNames,
            errorNames,
          };
        } catch (e) {
          console.error(`Failed to parse JUnit XML: ${e}`);
        }

        // Use streaming counts if JUnit failed or reported 0
        const finalCounts = (junitData && junitData.tests > 0) ? junitData : {
          tests: seenTests.size,
          failures: failedCount,
          errors: errorCount,
          skipped: skippedCount,
          time: undefined,
          failedNames: Array.from(failedTests),
          errorNames: Array.from(errorTests),
        };

        return {
          code: procResult.code,
          counts: finalCounts,
          collectedInfo,
          shouldAbort,
          abortReason,
        };
      },
      catch: (e) => new Error(`Failed to run pytest: ${e}`),
    });

    if (result.collectedInfo) {
      console.log(colors.gray(result.collectedInfo));
    }

    const { tests, failures, errors, skipped, time, failedNames, errorNames } =
      result.counts;
    const passed = tests - failures - errors - skipped;

    console.log();
    const durationStr = time ? ` ${colors.cyan(`${time.toFixed(2)}s`)}` : "";
    console.log(
      `${colors.bold(tests.toString())} tests completed in${durationStr}:`,
    );
    console.log(
      `  ${colors.green("successes")}: ${
        colors.bold(passed.toString())
      }/${tests}`,
    );
    console.log(
      `  ${colors.red("failures")}:  ${
        colors.bold(failures.toString())
      }/${tests}`,
    );
    if (errors > 0) {
      console.log(
        `  ${colors.red("errors")}:    ${
          colors.bold(errors.toString())
        }/${tests}`,
      );
    }
    if (skipped > 0) {
      console.log(
        `  ${colors.gray("skipped")}:   ${
          colors.bold(skipped.toString())
        }/${tests}`,
      );
    }

    if (failedNames.length > 0) {
      console.log(colors.red("\nFailures:"));
      for (const name of failedNames) {
        console.log(`  ${colors.red("-")} ${name}`);
      }
    }

    if (errorNames.length > 0) {
      console.log(colors.red("\nErrors:"));
      for (const name of errorNames) {
        console.log(`  ${colors.red("-")} ${name}`);
      }
    }

    if (errors > 0 || (result.shouldAbort && result.abortReason)) {
      if (result.shouldAbort) {
        yield* Effect.fail(
          new Error(
            `Aborted due to ERROR: ${result.abortReason || "Test Error"}`,
          ),
        );
      } else {
        yield* Effect.fail(new Error(`s3-tests finished with errors.`));
      }
    }

    if (failures > 0 || result.code !== 0) {
      yield* Effect.fail(
        new Error(`s3-tests finished with failures (code ${result.code}).`),
      );
    }

    console.log(colors.green(`\n✓ s3-tests completed successfully.`));
  }).pipe(
    Effect.provide(Logger.minimumLogLevel(minLogLevel)),
  ));
});

if (import.meta.main) {
  Effect.runPromiseExit(program.pipe(Effect.scoped)).then((exitCode) => {
    if (exitCode._tag === "Failure") {
      console.error(
        colors.red(`Fatal error: ${JSON.stringify(exitCode.cause, null, 2)}`),
      );
      Deno.exit(1);
    }
  }).catch((e) => {
    console.error(colors.red(`Unhandled error: ${e}`));
    Deno.exit(1);
  });
}
