import {
    CreateBucketCommand,
    DeleteBucketCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    type S3Client,
    S3ServiceException,
} from "@aws-sdk/client-s3";
import { harness, type ProxyTestCase } from "../utils.ts";
import type { GlobalConfig } from "../../src/Domain/Config.ts";

const testConfig: GlobalConfig = {
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

interface ObjectTestSpec {
    name: string;
    fn: (client: S3Client) => Promise<unknown>;
    setup?: (client: S3Client) => Promise<void>;
    teardown?: (client: S3Client) => Promise<void>;
    expectedErrorCode?: string;
}

const BUCKET = "test-objects-bucket";

const specs: ObjectTestSpec[] = [
    {
        name: "objects/put",
        fn: (c) =>
            c.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: "test.txt",
                    Body: "hello world",
                }),
            ),
        teardown: async (c) => {
            try {
                await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "test.txt" }));
            } catch { /* ignore */ }
        },
    },
    {
        name: "objects/get/existing",
        fn: (c) => c.send(new GetObjectCommand({ Bucket: BUCKET, Key: "get.txt" })),
        setup: async (c) => {
            await c.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: "get.txt",
                    Body: "content to get",
                }),
            );
        },
        teardown: async (c) => {
            try {
                await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "get.txt" }));
            } catch { /* ignore */ }
        },
    },
    {
        name: "objects/get/non-existent",
        fn: (c) => c.send(new GetObjectCommand({ Bucket: BUCKET, Key: "no-such" })),
        expectedErrorCode: "NoSuchKey",
    },
    {
        name: "objects/head/existing",
        fn: (c) => c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: "head.txt" })),
        setup: async (c) => {
            await c.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: "head.txt",
                    Body: "content to head",
                }),
            );
        },
        teardown: async (c) => {
            try {
                await c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "head.txt" }));
            } catch { /* ignore */ }
        },
    },
    {
        name: "objects/head/non-existent",
        fn: (c) => c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: "no-such-head" })),
        expectedErrorCode: "NotFound",
    },
    {
        name: "objects/delete/existing",
        fn: (c) =>
            c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "delete.txt" })),
        setup: async (c) => {
            await c.send(
                new PutObjectCommand({
                    Bucket: BUCKET,
                    Key: "delete.txt",
                    Body: "content to delete",
                }),
            );
        },
    },
];

async function runObjectTest(tc: ObjectTestSpec, client: S3Client) {
    try {
        await tc.setup?.(client);

        try {
            await tc.fn(client);
            if (tc.expectedErrorCode) {
                throw new Error(
                    `Expected error code ${tc.expectedErrorCode} but command succeeded for ${tc.name}`,
                );
            }
        } catch (e: unknown) {
            if (e instanceof S3ServiceException) {
                if (tc.expectedErrorCode) {
                    if (e.name !== tc.expectedErrorCode) {
                        throw new Error(
                            `Error code mismatch for ${tc.name}: expected ${tc.expectedErrorCode}, got ${e.name}`,
                        );
                    }
                } else {
                    throw e;
                }
            } else {
                throw e;
            }
        }
    } finally {
        await tc.teardown?.(client);
    }
}

const cases: ProxyTestCase[] = specs.map((spec) => ({
    name: spec.name,
    config: testConfig,
    beforeAll: async (client: S3Client) => {
        try {
            await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
        } catch { /* ignore if already exists */ }
    },
    afterAll: async (client: S3Client) => {
        try {
            await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
        } catch { /* ignore */ }
    },
    fn: (client: S3Client) => runObjectTest(spec, client),
}));

harness(cases);

