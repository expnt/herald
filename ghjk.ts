import { file, ports, stdDeps } from "./tools/deps.ts";
import opentofu_ghrel from "./tools/opentofu_ghrel.port.ts";
import mc from "./tools/mc.port.ts";


// constants
const DENO_VERSION = "2.2.3";
const PYTHON_VERSION = "3.9.19";
const DOCKER_CMD = Deno.env.get("DOCKER_CMD") ?? "docker";

// installs
const installs = {
  deno: ports.deno_ghrel({
    version: DENO_VERSION,
  }),
  python: ports.cpy_bs({ version: PYTHON_VERSION, releaseTag: "20240814" }),
}

const ghjk = file({
    tasks: {

      "dev-compose": {
    desc: "Wrapper around docker compose to manage runtime dependencies",
    async fn($) {
      const dcs = await Array.fromAsync(
        $.workingDir.join("tools/compose").expandGlob("compose.*.yml", {
          includeDirs: false,
          globstar: true,
        }),
      );
      const files = Object.fromEntries(
        dcs.map((e) => [e.path.basename().split(".")[1], e.path]),
      );

      const on = new Set<string>();
      if ($.argv.length === 1 && $.argv[0] === "all") {
        Object.values(files).forEach((e) => on.add(e.toString()));
      } else {
        for (const arg of $.argv) {
          if (!files[arg]) {
            console.log(
              `Unknown env "${arg}", available: ${
                Object.keys(files).join(
                  ", ",
                )
              } or "all".`,
            );
            Deno.exit(1);
          }
          on.add(files[arg].toString());
        }
      }

      if (on.size > 0) {
        await $.raw`${DOCKER_CMD} compose ${
          [...on].flatMap((file) => [
            "-f",
            file,
          ])
        } up -d --remove-orphans`;
      } else {
        await $.raw`${DOCKER_CMD} compose ${
          Object.values(files).flatMap((file) => [
            "-f",
            file,
          ])
        } down --remove-orphans --volumes`;
      }
    },
  },

  "dev-proxy": {
    desc: "Run the proxy inside a docker container",
    async fn($) {
      const arg = $.argv[0];
      if (arg !== 'up' && arg !== 'down') {
        console.log(
          `Unsupported subcommand "${arg}", available: 'up' and 'down'`,
        );
        Deno.exit(1);
      }

      if (arg === "up") {
        await $.raw`${DOCKER_CMD} compose up -d --remove-orphans`;
        console.log("It might take some time for the proxy to download dependencies based on your internet speed")
      } else {
        await $.raw`${DOCKER_CMD} compose down --remove-orphans --volumes`;
      }
    }
  },


  "build-proxy": {
    desc: "Rebuild the proxy docker image",
    async fn($) {
      await $.raw`${DOCKER_CMD} compose build --no-cache proxy`;
      await $.raw`${DOCKER_CMD} compose up -d --force-recreate`;
    }
  },

  "install-sys-deps": {
    desc: "Install system dependencies",
    async fn($) {
      // deno
      await $.raw`curl -fsSL https://deno.land/install.sh | sh`;
      // FIXME: there's a pre-commit port down below??
      // pre-commit
      await $.raw`pip install pre-commit`;
      await $.raw`pre-commit install`;
    }
  },

  "setup-auth": {
    desc: "Setup auth",
    async fn($) {
      const namespace = "stg-s3-herald";
      const podNameCommand = `kubectl get pod -n ${namespace} -l 'app=herald' -o jsonpath='{.items[0].metadata.name}'`;
      const podName = await $.raw`${podNameCommand}`.stdout("piped").stderr("piped");

      const token = await $.raw`kubectl exec ${podName} -n ${namespace} -- cat /var/run/secrets/kubernetes.io/serviceaccount/token`.stdout("piped").stderr("piped");
      const tokenPath = "serviceaccount/token";
      Deno.env.set("SERVICE_ACCOUNT_TOKEN_PATH", tokenPath);
      await Deno.mkdir("serviceaccount", { recursive: true });
      await Deno.writeTextFile(tokenPath, token.stdout);

      const cert = await $.raw`kubectl exec ${podName} -n ${namespace} -- cat /var/run/secrets/kubernetes.io/serviceaccount/ca.crt`.stdout("piped").stderr("piped");
      const certPath = "serviceaccount/ca.crt";
      Deno.env.set("CERT_PATH", certPath);
      await Deno.writeTextFile(certPath, cert.stdout);
    }
  }

    },
  });

// ghjk.install(installs.deno, installs.python, ports.pipi({ packageName: "pre-commit", version: "3.7.1" })[0],);

export const sophon = ghjk.sophon;
const { env } = ghjk;

env("main")
.install(
  installs.deno,
  ports.pipi({ packageName: "pre-commit", version: "3.7.1" })[0],
  opentofu_ghrel(),
  ...Deno.build.os == "linux" ? [mc({version: "todo"})] :[],
).allowedBuildDeps(
  ...stdDeps(),
    installs.python,
).vars({
    S3_ACCESS_KEY: "minio",
    S3_SECRET_KEY: "password",
  });
