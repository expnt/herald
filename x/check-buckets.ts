import { ListBucketsCommand, S3Client } from "npm:@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
  forcePathStyle: true,
});

async function check() {
  const { Buckets } = await client.send(new ListBucketsCommand({}));
  console.log(JSON.stringify(Buckets, null, 2));
}

check().catch(console.error);
