import { assertEquals } from "std/assert";
import * as path from "std/path/";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createTempFile, createTempStream } from "../../../utils/file.ts";
import { assert } from "std/assert";
import { getS3Client, setupBucket } from "../../../utils/s3.ts";
import { Upload } from "aws-sdk/lib-storage";

const filePath = await createTempFile(1); // 1MB

const bucket = "s3-test";
const objectKey = path.basename(filePath);

const s3 = getS3Client({
  credentials: {
    accessKeyId: "minio",
    secretAccessKey: "password",
  },
  region: "local",
  forcePathStyle: true,
  endpoint: "http://localhost:8000",
});

async function deleteBucketIfExists(bucketName: string) {
  while (true) {
    const list = await listObjects(s3, bucketName);
    if (list == null) {
      return;
    }
    if (list.length === 0) {
      break;
    }

    for (const { Key } of list) {
      await s3.send(
        new DeleteObjectCommand({ Bucket: bucketName, Key: Key! }),
      );
    }
  }

  const deleteCommand = new DeleteBucketCommand({ Bucket: bucketName });
  await s3.send(deleteCommand);
}

export async function listObjects(client: S3Client, bucketName: string) {
  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
    });
    const res = await client.send(listCommand);
    return res.Contents ?? [];
  } catch (e) {
    if ((e as Error).name === "NoSuchBucket") {
      return null;
    }
    throw e;
  }
}

const uploadWithSDK = async (t: Deno.TestContext) => {
  const body = await Deno.readFile(filePath);

  // delete bucket if exists
  await t.step(async function cleanup() {
    await deleteBucketIfExists(bucket);
  });

  // create bucket first
  const createBucketCommand = new CreateBucketCommand({
    Bucket: bucket,
  });

  const createBucketResponse = await s3.send(createBucketCommand);
  assertEquals(200, createBucketResponse.$metadata.httpStatusCode);

  const uploadCommand = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
  });

  const res = await s3.send(uploadCommand);
  assertEquals(200, res.$metadata.httpStatusCode);
};

Deno.test("upload an object to s3", uploadWithSDK);

Deno.test(async function getUploaded() {
  const getObject = new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
  });
  const response = await s3.send(getObject);
  const body = await response.Body?.transformToByteArray();
  assert(body instanceof Uint8Array);
});

Deno.test(async function deleteUploaded() {
  const deleteObject = new DeleteObjectCommand({
    Bucket: bucket,
    Key: path.basename(filePath),
  });

  const res = await s3.send(deleteObject);
  assertEquals(204, res.$metadata.httpStatusCode);
});

Deno.test(async function streamUpload() {
  await setupBucket(s3, bucket);

  const { stream: fileStream, fileName, size } = await createTempStream();

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: fileName,
      Body: fileStream,
      ContentLength: size,
    },
  });

  const res = await upload.done();
  assertEquals(200, res.$metadata.httpStatusCode);
});
Deno.test(async function presignUpload() {
  await setupBucket(s3, bucket);

  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Length", (1 * 1024 * 1024).toString());

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }),
    {
      expiresIn: 60,
    },
  );

  const body = await Deno.readFile(filePath);

  const res = await fetch(url, {
    method: "PUT",
    body,
    headers,
  });
  if (!res.ok) {
    throw new Error("error uploading through presign: ", { cause: res });
  }
  assert(await res.blob());
});

Deno.test(async function presignDownload() {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }),
    {
      expiresIn: 60,
    },
  );

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error("error downloading through presign: ", { cause: resp });
  }
  assert(await resp.blob());
});

Deno.test(async function presignDelete() {
  const url = await getSignedUrl(
    s3,
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }),
    {
      expiresIn: 60,
    },
  );

  const res = await fetch(url, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error("error deleting through presign: ", { cause: res });
  }
  assert(await res.blob());
});

Deno.test(async function presignUploadMulti() {
  // TODO:
});
