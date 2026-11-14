import test from 'node:test';
import * as assert from 'node:assert/strict';
import { S3Service } from '../src/s3-service.ts';
import type AWS from 'aws-sdk';

test('S3Service (Legacy v2): Upload, download, and list operations', async (t) => {
  // Deterministic mock client for offline baseline testing
  const fakeS3Client: unknown = {
    upload(params: AWS.S3.PutObjectRequest) {
      return {
        promise: async () => ({
          Location: `https://${params.Bucket}.s3.amazonaws.com/${params.Key}`,
          ETag: '"etag-123"',
          Bucket: params.Bucket,
          Key: params.Key,
        }),
      };
    },
    getObject(params: AWS.S3.GetObjectRequest) {
      return {
        promise: async () => ({
          Body: {
            toString: () => `Mock content for ${params.Key}`,
          },
        }),
      };
    },
    listObjectsV2(params: AWS.S3.ListObjectsV2Request) {
      return {
        promise: async () => ({
          Contents: [
            { Key: `${params.Prefix || ''}file1.txt` },
            { Key: `${params.Prefix || ''}file2.txt` },
          ],
        }),
      };
    },
  };

  const service = new S3Service(fakeS3Client as AWS.S3);

  await t.test('uploadFile returns valid location and key', async () => {
    const res = await service.uploadFile('my-bucket', 'docs/sample.txt', 'Hello AWS SDK');
    assert.equal(res.key, 'docs/sample.txt');
    assert.ok(res.location.includes('my-bucket'));
  });

  await t.test('downloadFile returns decoded content', async () => {
    const text = await service.downloadFile('my-bucket', 'docs/sample.txt');
    assert.equal(text, 'Mock content for docs/sample.txt');
  });

  await t.test('listFiles returns keys array', async () => {
    const files = await service.listFiles('my-bucket', 'docs/');
    assert.equal(files.length, 2);
    assert.equal(files[0], 'docs/file1.txt');
  });
});
