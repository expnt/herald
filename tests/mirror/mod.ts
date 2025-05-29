import { S3ClientConfig } from "aws-sdk/client-s3";
import { configInit, globalConfig } from "../../src/config/mod.ts";

await configInit();

export const s3MirrorBuckets = [
  "s3-mirror-test",
  "s3-mirror-test",
  "s3-mirror-test",
];
const s3ContainerConfigs = s3MirrorBuckets.map((key) =>
  globalConfig.buckets[key].config
);

export const s3MirrorConfigs: S3ClientConfig[] = [
  {
    endpoint: "http://localhost:8000",
    forcePathStyle: true,
    region: s3ContainerConfigs[0].region,
    credentials: "accessKeyId" in s3ContainerConfigs[0].credentials
      ? s3ContainerConfigs[0].credentials
      : {
        accessKeyId: s3ContainerConfigs[0].credentials.username,
        secretAccessKey: s3ContainerConfigs[0].credentials.password,
      },
  },
  {
    endpoint: "http://localhost:8000",
    forcePathStyle: true,
    region: s3ContainerConfigs[1].region,
    credentials: "accessKeyId" in s3ContainerConfigs[1].credentials
      ? s3ContainerConfigs[1].credentials
      : {
        accessKeyId: s3ContainerConfigs[1].credentials.username,
        secretAccessKey: s3ContainerConfigs[1].credentials.password,
      },
  },
  {
    endpoint: "http://localhost:8000",
    forcePathStyle: true,
    region: s3ContainerConfigs[2].region,
    credentials: "accessKeyId" in s3ContainerConfigs[2].credentials
      ? s3ContainerConfigs[2].credentials
      : {
        accessKeyId: s3ContainerConfigs[2].credentials.username,
        secretAccessKey: s3ContainerConfigs[2].credentials.password,
      },
  },
];

export const SYNC_WAIT = 10000;
export const s3_docker_container = "compose-minio-1";

export const swiftMirrorBuckets = [
  "swift-mirror-test",
  "swift-mirror-test",
  "swift-mirror-test",
];

const swiftContainerConfigs = swiftMirrorBuckets.map((key) =>
  globalConfig.buckets[key].config
);

export const swiftMirrorConfigs: S3ClientConfig[] = [
  {
    endpoint: "http://localhost:8000",
    forcePathStyle: true,
    region: swiftContainerConfigs[0].region,
    credentials: "accessKeyId" in swiftContainerConfigs[0].credentials
      ? swiftContainerConfigs[0].credentials
      : {
        accessKeyId: swiftContainerConfigs[0].credentials.username,
        secretAccessKey: swiftContainerConfigs[0].credentials.password,
      },
  },
  {
    endpoint: "http://localhost:8000",
    forcePathStyle: true,
    region: swiftContainerConfigs[1].region,
    credentials: "accessKeyId" in swiftContainerConfigs[1].credentials
      ? swiftContainerConfigs[1].credentials
      : {
        accessKeyId: swiftContainerConfigs[1].credentials.username,
        secretAccessKey: swiftContainerConfigs[1].credentials.password,
      },
  },
  {
    endpoint: "http://localhost:8000",
    forcePathStyle: true,
    region: swiftContainerConfigs[2].region,
    credentials: "accessKeyId" in swiftContainerConfigs[2].credentials
      ? swiftContainerConfigs[2].credentials
      : {
        accessKeyId: swiftContainerConfigs[2].credentials.username,
        secretAccessKey: swiftContainerConfigs[2].credentials.password,
      },
  },
];

export async function startDockerContainer(
  containerName: string,
): Promise<void> {
  const startCommand = new Deno.Command("docker", {
    args: ["start", containerName],
  });

  const { code, stderr } = await startCommand.output();

  if (code !== 0) {
    throw new Error(
      `Error starting container: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

export async function stopDockerContainer(
  containerName: string,
): Promise<void> {
  const stopCommand = new Deno.Command("docker", {
    args: ["stop", containerName],
  });

  const { code: stopCode, stderr: stopStderr } = await stopCommand.output();

  if (stopCode !== 0) {
    throw new Error(
      `Error stopping container: ${new TextDecoder().decode(stopStderr)}`,
    );
  }
}
