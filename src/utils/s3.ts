import { S3Client } from "bun";

export const spaces = new S3Client({
  bucket: 'uploads',
  region: 'fra1',
  accessKeyId: process.env.DIGITAL_OCEAN_SPACE_KEY,
  secretAccessKey: process.env.DIGITAL_OCEAN_SPACE_SECRET,
  endpoint: process.env.DIGITAL_OCEAN_SPACE_URL,
});

export async function downloadFromS3ToDisk(s3Path: string, localPath: string) {
  await Bun.write(localPath, spaces.file(s3Path));
}

export async function uploadToS3FromDisk(localPath: string, s3Path: string) {
  await spaces.write(s3Path, Bun.file(localPath));
}
