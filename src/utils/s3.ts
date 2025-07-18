import { S3Client } from 'bun';
import path from 'path';
import { logTask, type Task } from './tasks.ts';
import { createFile, getFile, updateFile, type UserFile } from './files.ts';
import { TEMP_DIR } from './dirs.ts';
import { tryCatch } from './promises.ts';
import { getLocalFileMetadata } from './ffmpeg.ts';

export const spaces = new S3Client({
  bucket: 'bunpeg',
  region: 'fra1',
  accessKeyId: process.env.DIGITAL_OCEAN_SPACE_KEY,
  secretAccessKey: process.env.DIGITAL_OCEAN_SPACE_SECRET,
  endpoint: process.env.DIGITAL_OCEAN_SPACE_URL,
});

export async function downloadFromS3ToDisk(s3Path: string, localPath: string) {
  await Bun.write(localPath, spaces.file(s3Path));
}

export async function uploadToS3FromDisk(localPath: string, s3Path: string, options?: Bun.S3Options) {
  await spaces.write(s3Path, Bun.file(localPath), options);
}

interface Params {
  task: Task;
  fileIds: string[];
  outputFile: string;
  parentFile?: string;
  operation: (params: { s3Paths: string[]; inputPaths: string[]; outputPath: string }) => Promise<void>;
}

/**
 * This function handles downloading the source file from the S3 client
 * and the subsequent upload, plus cleanup of local files.
 * This version is for the `replace` mode of operations.
 */
export async function handleS3DownAndUpSwap(params: Params) {
  const { task, outputFile, parentFile } = params;
  const { s3Paths, inputPaths, outputPath } = await __executeS3DownAndUp(params);

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
    } : {}),
    ...(parentFile ? {
      parent: parentFile,
    } : {})
  });

  for (const s3Path of s3Paths) {
    const s3File = spaces.file(s3Path);
    await s3File.delete();
  }

  await cleanupFiles([...inputPaths, outputPath]);
}

/**
 * This function handles downloading the source file from the S3 client
 * and the subsequent upload, plus cleanup of local files.
 * This version is for the `append` mode of operations.
 */
export async function handleS3DownAndUpAppend(params: Params) {
  const { task, outputFile, parentFile } = params;
  const { inputPaths, outputPath } = await __executeS3DownAndUp(params);
  const newFileId = extractFileName(outputFile);
  const newFile = Bun.file(outputFile);

  const { data: newFileName } = await tryCatch(resolveNewFileName(task.file_id, outputFile));

  await createFile({
    id: newFileId,
    file_name: newFileName ?? outputFile,
    file_path: outputFile,
    mime_type: newFile.type,
    ...(parentFile ? { parent: parentFile } : {})
  });

  const { data: metadata } = await tryCatch(getLocalFileMetadata(outputPath));
  if (metadata) {
    await updateFile(newFileId, { metadata: JSON.stringify(metadata.meta) });
  }

  await cleanupFiles([...inputPaths, outputPath]);
}

/**
 * This is the function that actually handles downloading the source file from the S3 client
 * and the subsequent upload, leaving the cleanup to the caller.
 */
async function __executeS3DownAndUp(params: Params) {
  const { task, fileIds, outputFile, operation } = params;

  const s3Paths: string[] = [];
  const inputPaths: string[] = [];
  const outputPath = path.join(TEMP_DIR, outputFile);

  for (const fileId of fileIds) {
    const { data: file, error } = await tryCatch(getFile(fileId));
    if (error || !file) {
      throw new Error(`Could not find file ${fileId}`);
    }

    s3Paths.push(file.file_path);
  }

  for (const s3Path of s3Paths) {
    const localPath = path.join(TEMP_DIR, s3Path);

    const { error: downloadError } = await tryCatch(downloadFromS3ToDisk(s3Path, localPath));
    if (downloadError) {
      logTask(task.id, `Failed to download file ${s3Path} from S3`);
      await cleanupFiles([...inputPaths, outputPath]);
      throw downloadError;
    }

    inputPaths.push(localPath);
  }

  const { error: operationError } = await tryCatch(operation({ s3Paths, inputPaths, outputPath }));
  if (operationError) {
    logTask(task.id, 'Failed to execute operation');
    await cleanupFiles([...inputPaths, outputPath]);
    throw operationError;
  }

  const { error: uploadError } = await tryCatch(uploadToS3FromDisk(outputPath, outputFile));
  if (uploadError) {
    logTask(task.id, 'Failed to upload from S3');
    await cleanupFiles([...inputPaths, outputPath]);
    throw uploadError;
  }

  return { s3Paths, inputPaths, outputPath };
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

export async function cleanupFiles(filePaths: string[]) {
  for (const iPath of filePaths) {
    await cleanupFile(iPath);
  }
}

export async function cleanupFile(path: string) {
  const file = Bun.file(path);

  if (await file.exists()) {
    await file.delete();
  }
}
