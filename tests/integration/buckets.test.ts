import {
    CreateBucketCommand,
    DeleteBucketCommand,
    HeadBucketCommand,
    ListBucketsCommand,
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

interface BucketTestSpec {
    name: string;
    fn: (client: S3Client) => Promise<unknown>;
    setup?: (client: S3Client) => Promise<void>;
    teardown?: (client: S3Client) => Promise<void>;
    expectedErrorCode?: string;
}

const specs: BucketTestSpec[] = [
    {
        name: "buckets/create/new",
        fn: (c) => c.send(new CreateBucketCommand({ Bucket: "test-create-1" })),
        teardown: async (c) => {
            try {
                await c.send(new DeleteBucketCommand({ Bucket: "test-create-1" }));
            } catch { /* ignore */ }
        },
    },
    {
        name: "buckets/create/existing",
        fn: (c) => c.send(new CreateBucketCommand({ Bucket: "test-dup" })),
        setup: async (c) => {
            await c.send(new CreateBucketCommand({ Bucket: "test-dup" }));
        },
        expectedErrorCode: "BucketAlreadyOwnedByYou",
        teardown: async (c) => {
            try {
                await c.send(new DeleteBucketCommand({ Bucket: "test-dup" }));
            } catch { /* ignore */ }
        },
    },
    {
        name: "buckets/delete/existing",
        fn: (c) =>
            c.send(new DeleteBucketCommand({ Bucket: "test-delete-exists" })),
        setup: async (c) => {
            await c.send(new CreateBucketCommand({ Bucket: "test-delete-exists" }));
        },
    },
    {
        name: "buckets/delete/non-existent",
        fn: (c) => c.send(new DeleteBucketCommand({ Bucket: "no-such" })),
        expectedErrorCode: "NoSuchBucket",
    },
    {
        name: "buckets/head/existing",
        fn: (c) => c.send(new HeadBucketCommand({ Bucket: "test-head" })),
        setup: async (c) => {
            await c.send(new CreateBucketCommand({ Bucket: "test-head" }));
        },
        teardown: async (c) => {
            try {
                await c.send(new DeleteBucketCommand({ Bucket: "test-head" }));
            } catch { /* ignore */ }
        },
    },
    {
        name: "buckets/head/non-existent",
        fn: (c) => c.send(new HeadBucketCommand({ Bucket: "no-such-2" })),
        expectedErrorCode: "NotFound",
    },
    {
        name: "buckets/list",
        fn: (c) => c.send(new ListBucketsCommand({})),
    },
];

async function runBucketTest(tc: BucketTestSpec, client: S3Client) {
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
    fn: (client: S3Client) => runBucketTest(spec, client),
}));

harness(cases);
