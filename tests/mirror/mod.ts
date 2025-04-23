import { S3ClientConfig } from "aws-sdk/client-s3";

export const s3MirrorConfigs: S3ClientConfig[] = [
  {
    endpoint: "http://localhost:8000",
    region: "local",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "minio",
      secretAccessKey: "password",
    },
  },
  {
    endpoint: "http://localhost:8000",
    region: "local",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "test:tester",
      secretAccessKey: "testing",
    },
  },
  {
    endpoint: "http://localhost:8000",
    region: "local",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "minio",
      secretAccessKey: "password",
    },
  },
];

export const s3MirrorBuckets = [
  "s3-mirror-test",
  "s3-mirror-test",
  "s3-mirror-test",
];

export const SYNC_WAIT = 10000;
export const s3_docker_container = "compose-minio-1";

export const swiftMirrorConfigs: S3ClientConfig[] = [
  {
    endpoint: "http://localhost:8000",
    region: "local",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "test:tester",
      secretAccessKey: "testing",
    },
  },
  {
    endpoint: "http://localhost:8000",
    region: "local",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "test:tester",
      secretAccessKey: "password",
    },
  },
  {
    endpoint: "http://localhost:8000",
    region: "local",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "test:tester",
      secretAccessKey: "testing",
    },
  },
];

export const swiftMirrorBuckets = [
  "swift-mirror-test",
  "swift-mirror-test",
  "swift-mirror-test",
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
