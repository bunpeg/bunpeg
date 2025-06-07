import { $ } from 'bun';
import path from 'path';
import { getTask, logTask, markPendingTasksForFileAsUnreachable, updateTask } from './tasks';
import { getFile, updateFile } from './files';
import { downloadFromS3ToDisk, spaces, uploadToS3FromDisk } from './s3.ts';
import { after } from './queue-bg.ts';

const tempDir = "./data/temp";

export function transcode(s3Path: string, outputFormat: string, taskId: string) {
  void handleS3DownAndUp({
    taskId,
    s3Path,
    outputFile: `${taskId}.${outputFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(["-i", inputPath, outputPath], taskId);
    },
  });
}

export function trim(s3Path: string, start: string, duration: string, outputFormat: string, taskId: string) {
  void handleS3DownAndUp({
    taskId,
    s3Path,
    outputFile: `${taskId}.${outputFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(['-i', inputPath, '-ss', start, '-t', duration, '-c', 'copy', outputPath], taskId);
    },
  });
}

export function extractAudio(s3Path: string, audioFormat: string, taskId: string) {
  void handleS3DownAndUp({
    taskId,
    s3Path,
    outputFile: `${taskId}.${audioFormat}`,
    operation: (inputPath, outputPath) => {
      return runFFmpeg(["-i", inputPath, "-vn", "-acodec", "copy", outputPath], taskId)
    },
  });
}

export async function cutEnd(s3Path: string, duration: string, outputFormat: string, taskId: string) {
  void handleS3DownAndUp({
    taskId,
    s3Path,
    outputFile: `${taskId}.${outputFormat}`,
    operation: async (inputPath, outputPath) => {
      const totalDuration = await getVideoDuration(inputPath);
      const keepDuration = totalDuration - parseFloat(duration);
      if (keepDuration <= 0) throw new Error("Resulting video would be empty");

      return runFFmpeg(["-i", inputPath, "-vn", "-acodec", "copy", outputPath], taskId)
    },
  });
}

export async function getVideoDuration(filePath: string) {
  const response = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  return parseFloat(response.text().trim());
}

export async function getVideoMetadata(s3Path: string) {
  const inputPath = path.join(tempDir, s3Path);
  await downloadFromS3ToDisk(s3Path, inputPath);

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
  await cleanUpFile(inputPath);

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

export async function getAudioMetadata(s3Path: string) {
  const inputPath = path.join(tempDir, s3Path);
  await downloadFromS3ToDisk(s3Path, inputPath);

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
  await cleanUpFile(inputPath);

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

export async function updateFileMetadataById(fileId: string) {
  const file = await getFile(fileId);
  if (!file) throw new Error(`File ${fileId} not found!`);

  const s3File = spaces.file(file.file_path);
  if (!(await s3File.exists())) throw new Error(`S3 File ${file.file_path} not found!`);

  const mimeType = s3File.type;

  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');

  if (isVideo) {
    const meta = await getVideoMetadata(file.file_path);
    return updateFile(fileId, { mime_type: mimeType, metadata: JSON.stringify(meta) });
  }

  if (isAudio) {
    const meta = await getAudioMetadata(file.file_path);
    return updateFile(fileId, { mime_type: mimeType, metadata: JSON.stringify(meta) });
  }

  throw new Error(`File ${fileId} has unknown type: ${mimeType}`);
}

interface Params {
  taskId: string;
  s3Path: string;
  outputFile: string;
  operation: (inputPath: string, outputPath: string) => Promise<void>;
}
async function handleS3DownAndUp(params: Params) {
  const { taskId, s3Path, outputFile, operation } = params;
  const inputPath = path.join(tempDir, s3Path);
  const outputPath = path.join(tempDir, outputFile);
  let error;

  try {
    await downloadFromS3ToDisk(s3Path, inputPath);
    await operation(inputPath, outputPath);
    await uploadToS3FromDisk(outputPath, outputFile);

    const task = await getTask(taskId);
    if (!task) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error(`Task ${taskId} not found!`);
    }

    const file = await getFile(task.file_id);
    if (!file) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error(`File ${task.file_id} not found!`);
    }

    const oldExt = path.extname(file.file_name);
    const cleanName = path.basename(`${tempDir}/${file.file_name}`, oldExt);

    const newExt = path.extname(outputFile);
    const newName = `${cleanName}${newExt}`;

    await updateFile(task.file_id, { file_name: newName, file_path: outputFile });
    await updateTask(taskId, { status: 'completed' });

    const s3File = spaces.file(s3Path);
    await s3File.delete();

    after(async () => {
      await updateFileMetadataById(file.id);
    });

  } catch (err) {
    error = err;
  }
  finally {
    await cleanUpFile(inputPath);
    await cleanUpFile(outputPath);
  }

  if (error) throw error;
}

async function cleanUpFile(path: string) {
  const file = Bun.file(path);

  if (await file.exists()) {
    await file.delete();
  }
}

async function runFFmpeg(args: string[], taskId: string) {
  const task = await getTask(taskId);

  if (!task) throw new Error(`Task ${taskId} not found!`);

  logTask(taskId, 'Running ffmpeg...');

  const proc = Bun.spawn(["ffmpeg", ...args], {
    timeout: 1000 * 60 * 15, // 15 minutes
  });

  await updateTask(taskId, { status: "processing", pid: proc.pid });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    logTask(taskId, `ffmpeg finished with exit code ${proc.exitCode} (${proc.signalCode})`);
    console.log('error', error);
    await updateTask(taskId, { status: "failed", error });
    await markPendingTasksForFileAsUnreachable(task.file_id);
    throw new Error(error);
  } else {
    logTask(taskId, 'ffmpeg finished with exit code 0');
  }
}
