import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "npm:@aws-sdk/client-s3";

const client = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  credentials: {
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
  forcePathStyle: true,
});

async function purge() {
  const { Buckets } = await client.send(new ListBucketsCommand({}));
  for (const bucket of Buckets ?? []) {
    const name = bucket.Name;
    if (!name) continue;
    console.log(`Purging bucket: ${name}`);

    // List and delete all versions and delete markers
    let isTruncated = true;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    while (isTruncated) {
      const list = await client.send(
        new ListObjectVersionsCommand({
          Bucket: name,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );

      const toDelete: { Key: string; VersionId: string }[] = [];
      if (list.Versions) {
        for (const v of list.Versions) {
          if (v.Key) toDelete.push({ Key: v.Key, VersionId: v.VersionId! });
        }
      }
      if (list.DeleteMarkers) {
        for (const dm of list.DeleteMarkers) {
          if (dm.Key) toDelete.push({ Key: dm.Key, VersionId: dm.VersionId! });
        }
      }

      if (toDelete.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: name,
            Delete: {
              Objects: toDelete,
            },
          }),
        );
      }

      isTruncated = list.IsTruncated ?? false;
      keyMarker = list.NextKeyMarker;
      versionIdMarker = list.NextVersionIdMarker;
    }

    // Delete bucket
    try {
      await client.send(new DeleteBucketCommand({ Bucket: name }));
    } catch (e) {
      console.error(`Failed to delete bucket ${name}: ${e}`);
    }
  }
}

purge().catch(console.error);
