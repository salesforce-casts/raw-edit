/**
 * Create the development bucket if it is not there yet.
 * Uses the same S3 API as production, so MinIO and R2 are interchangeable.
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

const bucket = process.env.R2_BUCKET;
const endpoint = process.env.R2_ENDPOINT;

if (!bucket || !endpoint) {
  console.error('R2_BUCKET and R2_ENDPOINT must be set.');
  process.exit(1);
}

const client = new S3Client({
  region: process.env.R2_REGION ?? 'auto',
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`Bucket "${bucket}" already exists.`);
} catch {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Bucket "${bucket}" created.`);
}
