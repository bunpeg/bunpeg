import { $ } from 'bun';
import path from 'path';
import { nanoid } from 'nanoid';
import { TEMP_DIR } from '../index.ts';
import { logTask, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks';
import { getFile, updateFile, type UserFile } from './files';
import {
  spaces,
  cleanUpFile,
  uploadToS3FromDisk,
  downloadFromS3ToDisk,
  handleS3DownAndUpSwap,
  handleS3DownAndUpAppend,
} from './s3.ts';
import { tryCatch } from './promises.ts';
import { after } from './queue-bg.ts';

export async function transcode(s3Path: string, outputFormat: string, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    s3Path,
    outputFile: `${task.code}.${outputFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(["-i", inputPath, outputPath], task);
    },
  });
}

export async function resizeVideo(s3Path: string, width: number, height: number, outputFormat: string, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    s3Path,
    outputFile: `${task.code}.${outputFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(['-i', inputPath, '-vf', `scale=${width}:${height}`, outputPath], task);
    },
  });
}

export async function trim(s3Path: string, start: number, duration: number, outputFormat: string, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    s3Path,
    outputFile: `${task.code}.${outputFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(
        ['-i', inputPath, '-ss', start.toString(), '-t', duration.toString(), '-c', 'copy', outputPath],
        task,
      );
    },
  });
}

export async function cutEnd(s3Path: string, duration: number, outputFormat: string, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    s3Path,
    outputFile: `${task.code}.${outputFormat}`,
    operation: async (inputPath, outputPath) => {
      const totalDuration = await getVideoDuration(inputPath);
      const keepDuration = totalDuration - duration;
      if (keepDuration <= 0) throw new Error("Resulting video would be empty");

      void runFFmpeg(["-i", inputPath, "-t", keepDuration.toFixed(2), "-c", "copy", outputPath], task);
    },
  });
}

export async function extractAudio(s3Path: string, audioFormat: string, task: Task) {
  const newFileId = nanoid(8);
  const outputFile = `${newFileId}.${audioFormat}`;
  return handleS3DownAndUpAppend({
    task,
    s3Path,
    outputFile,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(["-i", inputPath, "-vn", "-acodec", "copy", outputPath], task);
    },
  });
}

export async function removeAudio(s3Path: string, outputFormat: string, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    s3Path,
    outputFile: `${task.code}.${outputFormat}`,
    operation: (inputPath, outputPath) => runFFmpeg(['-i', inputPath, '-an', outputPath], task),
  });
}

export async function addAudioTrack(s3VideoPath: string, s3AudioPath: string, outputFormat: string, task: Task) {
  const inputAudioPath = path.join(TEMP_DIR, s3AudioPath);

  const { error: downloadError } = await tryCatch(downloadFromS3ToDisk(s3AudioPath, inputAudioPath));
  if (downloadError) {
    logTask(task.id, 'Failed to download the audio track to add');
    await cleanUpFile(inputAudioPath);
    throw downloadError;
  }

  const { error } = await tryCatch(
    handleS3DownAndUpSwap({
      task,
      s3Path: s3VideoPath,
      outputFile: `${task.code}.${outputFormat}`,
      operation: async (inputVideoPath, outputPath) => {
        await runFFmpeg(['-i', inputVideoPath, '-i', inputAudioPath, '-c:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', outputPath], task);
      },
    })
  );
  await cleanUpFile(inputAudioPath);

  if (error) throw error;
}

export async function mergeMedia(s3Paths: string[], outputFormat: string, task: Task) {
  // Download all files to TEMP_DIR
  const inputPaths: string[] = [];
  for (const s3Path of s3Paths) {
    const inputPath = path.join(TEMP_DIR, s3Path);
    const { error: downloadError } = await tryCatch(downloadFromS3ToDisk(s3Path, inputPath));
    if (downloadError) {
      logTask(task.id, 'Failed to download from S3');
      after(async () => {
        for (const iPath of inputPaths) {
          await cleanUpFile(iPath);
        }
      });
      throw downloadError;
    }

    inputPaths.push(inputPath);
  }
  // Create concat list file
  const listFile = path.join(TEMP_DIR, `${task.code}_concat.txt`);
  const listContent = inputPaths.map(p => `file '${p}'`).join('\n');
  await Bun.write(listFile, listContent);
  const outputFile = `${task.code}.${outputFormat}`;
  const outputPath = path.join(TEMP_DIR, outputFile);

  const { error: operationError } = await tryCatch(
    runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath], task)
  );
  if (operationError) {
    logTask(task.id, 'Failed to execute operation');
    after(async () => {
      for (const iPath of inputPaths) {
        await cleanUpFile(iPath);
      }
      await cleanUpFile(outputPath);
    });
    throw operationError;
  }

  const { error: uploadError } = await tryCatch(uploadToS3FromDisk(outputPath, outputFile));
  if (uploadError) {
    after(async () => {
      for (const iPath of inputPaths) {
        await cleanUpFile(iPath);
      }
      await cleanUpFile(outputPath);
    });
    throw uploadError;
  }

  for (const p of inputPaths) await cleanUpFile(p);
  await cleanUpFile(listFile);
  await cleanUpFile(outputPath);
  // Update file record
  await updateFile(task.file_id, { file_name: outputFile, file_path: outputFile });
}

export async function extractThumbnail(s3Path: string, timestamp: string, imageFormat: string, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    s3Path,
    outputFile: `${task.code}.${imageFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(['-i', inputPath, '-ss', timestamp, '-vframes', '1', outputPath], task);
    },
  });
}

async function getVideoDuration(filePath: string) {
  const response = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  return parseFloat(response.text().trim());
}

export async function updateFileMetadata(fileId: UserFile['id']) {
  const { meta, mimeType } = await getFileMetadata(fileId);
  return updateFile(fileId, { mime_type: mimeType, metadata: JSON.stringify(meta) });
}

export async function getFileMetadata(fileId: UserFile['id']) {
  const file = await getFile(fileId);
  if (!file) throw new Error(`File ${fileId} not found!`);

  const s3File = spaces.file(file.file_path);
  if (!(await s3File.exists())) {
    console.log('getFileMetadata - file not found on S3');
    throw new Error(`S3 File ${file.file_path} not found!`);
  }

  const inputPath = path.join(TEMP_DIR, file.file_path);
  await downloadFromS3ToDisk(file.file_path, inputPath);
  const { data, error } = await tryCatch(getLocalFileMetadata(inputPath));
  await cleanUpFile(inputPath);

  if (error) throw error;
  return data;
}

export async function getLocalFileMetadata(filePath: string) {
  const localFile = Bun.file(filePath);
  if (!await localFile.exists()) throw new Error(`File on ${filePath} not found!`);

  const mimeType = localFile.type;

  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');

  if (isVideo) {
    const { data: meta, error } = await tryCatch(getVideoMetadata(filePath));
    if (error) throw error;
    return { meta, mimeType };
  }

  if (isAudio) {
    const { data: meta, error } = await tryCatch(getAudioMetadata(filePath));
    if (error) throw error;
    return { meta, mimeType };
  }

  throw new Error(`File on ${filePath} has unknown type: ${mimeType}`);
}

async function getVideoMetadata(inputPath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration,bit_rate,size",
    "-show_entries", "stream=width,height",
    "-of", "json",
    inputPath,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed: ${error}`);
  }

  const result = await new Response(proc.stdout).json() as any;
  const stream = result.streams?.[0];
  const format = result.format;

  return {
    fileSize: format?.size ? parseInt(format.size, 10) : null,
    duration: format?.duration ? parseFloat(format.duration) : null,
    bitrate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
    resolution: {
      width: stream?.width ?? null,
      height: stream?.height ?? null,
    },
  };
}

async function getAudioMetadata(inputPath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "format=duration,bit_rate,size",
    "-show_entries", "stream=sample_rate,channels",
    "-of", "json",
    inputPath,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed: ${error}`);
  }

  const result = await new Response(proc.stdout).json() as any;
  const stream = result.streams?.[0];
  const format = result.format;

  return {
    fileSize: format?.size ? parseInt(format.size, 10) : null,
    duration: format?.duration ? parseFloat(format.duration) : null,
    bitrate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
    sampleRate: stream?.sample_rate ? parseInt(stream.sample_rate, 10) : null,
    channels: stream?.channels ?? null,
  };
}

async function runFFmpeg(args: string[], task: Task) {
  logTask(task.id, 'Running ffmpeg...');

  const proc = Bun.spawn(["ffmpeg", ...args], {
    timeout: 1000 * 60 * 15, // 15 minutes
  });

  await updateTask(task.id, { status: "processing", pid: proc.pid });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    logTask(task.id, `ffmpeg finished with exit code ${proc.exitCode} (${proc.signalCode})`);
    console.log('error', error);
    await updateTask(task.id, { status: "failed", error });
    await markPendingTasksForFileAsUnreachable(task.file_id);
    throw new Error(error);
  }

  await updateTask(task.id, { status: 'completed' });
  logTask(task.id, 'ffmpeg finished with exit code 0');
}
