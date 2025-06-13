import { S3Client } from 'bun';
import path from 'path';
import { logTask, type Task } from './tasks.ts';
import { createFile, getFile, updateFile, type UserFile } from './files.ts';
import { TEMP_DIR } from '../index.ts';
import { tryCatch } from './promises.ts';
import { getLocalFileMetadata } from './ffmpeg.ts';
import { after } from './queue-bg.ts';

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

interface Params {
  task: Task;
  s3Path: string;
  outputFile: string;
  operation: (inputPath: string, outputPath: string) => Promise<void>;
}

/**
 * This function handles downloading the source file from the S3 client
 * and the subsequent upload, plus cleanup of local files.
 * This version is for operations that modify a file (eg: trim, transcode, remove-audio...).
 */
export async function handleS3DownAndUpSwap(params: Params) {
  await __executeS3DownAndUp(
    params,
    async () => {
      const { task, s3Path, outputFile } = params;
      const inputPath = path.join(TEMP_DIR, s3Path);
      const outputPath = path.join(TEMP_DIR, outputFile);

      const { data: newFileName, error: fileNameError } = await tryCatch(resolveNewFileName(task.file_id, outputFile));
      if (fileNameError) {
        console.error(`Could not resolve new file name for file ${task.file_id} on task ${task.id}`, fileNameError);
      }

      const { data, error: metadataError } = await tryCatch(getLocalFileMetadata(outputPath));
      if (metadataError) {
        console.error(`Could not resolve metadata for: ${outputPath}`, metadataError);
      }

      await updateFile(task.file_id, {
        file_name: newFileName ?? outputFile,
        file_path: outputFile,
        ...(data ? {
          mime_type: data.mimeType,
          metadata: JSON.stringify(data.meta),
        } : {})
      });

      after(async () => {
        const s3File = spaces.file(s3Path);
        await s3File.delete();
        await cleanUpFile(inputPath);
        await cleanUpFile(outputPath);
      });
    },
  );
}

/**
 * This function handles downloading the source file from the S3 client
 * and the subsequent upload, plus cleanup of local files.
 * This version is for operations that create a new file (eg: extract-audio, merge, extract-thumbnail...).
 */
export async function handleS3DownAndUpAppend(params: Params) {
  await __executeS3DownAndUp(
    params,
    async () => {
      console.log('handleS3DownAndUpAppend - cleanup');
      const { task, s3Path, outputFile } = params;
      const inputPath = path.join(TEMP_DIR, s3Path);
      const outputPath = path.join(TEMP_DIR, outputFile);

      const newFileId = extractFileName(outputFile);
      const newAudioFile = Bun.file(outputFile);
      const { data: newFileName } = await tryCatch(resolveNewFileName(task.file_id, outputFile));
      console.log('newFileName: ', newFileName);

      await createFile({
        id: newFileId,
        file_name: newFileName ?? outputFile,
        file_path: outputFile,
        mime_type: newAudioFile.type,
      });

      const { data: metadata, error } = await tryCatch(getLocalFileMetadata(outputPath));
      if (metadata) {
        console.log('metadata', metadata);
        await updateFile(newFileId, { metadata: JSON.stringify(metadata.meta) });
      } else {
        console.log('failed to extract metadata from', outputFile);
        console.error(error);
      }

      after(async () => {
        await cleanUpFile(inputPath);
        await cleanUpFile(outputPath);
      });
    },
  );
}

/**
 * This is the function that actually handles downloading the source file from the S3 client
 * and the subsequent upload, leaving the cleanup to the caller.
 */
async function __executeS3DownAndUp(params: Params, cleanup: () => Promise<void>) {
  const { task, s3Path, outputFile, operation } = params;
  const inputPath = path.join(TEMP_DIR, s3Path);
  const outputPath = path.join(TEMP_DIR, outputFile);

  const { error: downloadError } = await tryCatch(downloadFromS3ToDisk(s3Path, inputPath));
  if (downloadError) {
    logTask(task.id, 'Failed to download from S3');
    after(async () => {
      await cleanUpFile(inputPath);
      await cleanUpFile(outputPath);
    });
    throw downloadError;
  }

  const { error: operationError } = await tryCatch(operation(inputPath, outputPath));
  if (operationError) {
    logTask(task.id, 'Failed to execute operation');
    after(async () => {
      await cleanUpFile(inputPath);
      await cleanUpFile(outputPath);
    });
    throw operationError;
  }

  const { error: uploadError } = await tryCatch(uploadToS3FromDisk(outputPath, outputFile));
  if (uploadError) {
    logTask(task.id, 'Failed to upload from S3');
    after(async () => {
      await cleanUpFile(inputPath);
      await cleanUpFile(outputPath);
    });
    throw uploadError;
  }

  await cleanup();
}

export async function resolveNewFileName(fileId: UserFile['id'], outputFile: string) {
  const file = await getFile(fileId);
  if (!file) {
    throw new Error(`File ${fileId} not found!`);
  }

  const cleanName = extractFileName(file.file_name);
  const newExt = path.extname(outputFile);
  return `${cleanName}${newExt}`;
}

function extractFileName(fileName: string) {
  const oldExt = path.extname(fileName);
  return path.basename(`${TEMP_DIR}/${fileName}`, oldExt);
}

export async function cleanUpFile(path: string) {
  const file = Bun.file(path);

  if (await file.exists()) {
    await file.delete();
  }
}
