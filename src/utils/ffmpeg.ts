import { $ } from 'bun';
import path from 'path';
import { nanoid } from 'nanoid';
import { TEMP_DIR } from '../index.ts';
import { logTask, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks';
import { getFile, updateFile, type UserFile } from './files';
import { cleanupFile, downloadFromS3ToDisk, handleS3DownAndUpAppend, handleS3DownAndUpSwap, spaces } from './s3.ts';
import { tryCatch } from './promises.ts';
import type {
  AddAudioTrackType,
  AudioFormat,
  CutEndType,
  ExtractAudioType,
  ExtractThumbnailType,
  MergeMediaType,
  RemoveAudioType,
  ResizeVideoType,
  TranscodeType,
  TrimType,
} from '../schemas.ts';

export async function transcode(args: TranscodeType, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    fileIds: [args.fileId],
    outputFile: `${task.code}.${args.format}`,
    operation: ({ inputPaths, outputPath }) => {
      return runFFmpeg(["-i", inputPaths[0]!, outputPath], task);
    },
  });
}

export async function resizeVideo(args: ResizeVideoType, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    fileIds: [args.fileId],
    outputFile: `${task.code}.${args.outputFormat}`,
    operation: ({ inputPaths, outputPath }) => {
      return runFFmpeg(['-i', inputPaths[0]!, '-vf', `scale=${args.width}:${args.height}`, outputPath], task);
    },
  });
}

export async function trim(args: TrimType, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    fileIds: [args.fileId],
    outputFile: `${task.code}.${args.outputFormat}`,
    operation: ({ inputPaths, outputPath }) => {
      return runFFmpeg(
        ['-i', inputPaths[0]!, '-ss', args.start.toString(), '-t', args.duration.toString(), '-c', 'copy', outputPath],
        task,
      );
    },
  });
}

export async function cutEnd(args: CutEndType, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    fileIds: [args.fileId],
    outputFile: `${task.code}.${args.outputFormat}`,
    operation: async ({ inputPaths, outputPath }) => {
      const totalDuration = await getVideoDuration(inputPaths[0]!);
      const keepDuration = totalDuration - args.duration;
      if (keepDuration <= 0) throw new Error("Resulting video would be empty");

      void runFFmpeg(["-i", inputPaths[0]!, "-t", keepDuration.toFixed(2), "-c", "copy", outputPath], task);
    },
  });
}

export async function extractAudio(args: ExtractAudioType, task: Task) {
  const newFileId = nanoid(8);
  const outputFile = `${newFileId}.${args.audioFormat}`;
  return handleS3DownAndUpAppend({
    task,
    fileIds: [args.fileId],
    outputFile,
    operation: ({ inputPaths, outputPath }) => {
      return runFFmpeg(["-i", inputPaths[0]!, "-vn", ...getAudioEncodingParams(args.audioFormat), outputPath], task);
    },
  });
}

export async function removeAudio(args: RemoveAudioType, task: Task) {
  return handleS3DownAndUpSwap({
    task,
    fileIds: [args.fileId],
    outputFile: `${task.code}.${args.outputFormat}`,
    operation: ({ inputPaths, outputPath }) => runFFmpeg(['-i', inputPaths[0]!, '-an', outputPath], task),
  });
}

export async function addAudioTrack(args: AddAudioTrackType, task: Task) {
  return handleS3DownAndUpAppend({
    task,
    fileIds: [args.videoFileId, args.audioFileId],
    outputFile: `${nanoid(8)}.${args.outputFormat}`,
    operation: async ({ inputPaths, outputPath }) => {
      await runFFmpeg(['-i', inputPaths[0]!, '-i', inputPaths[1]!, '-c:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', outputPath], task);
    },
  })
}

export async function mergeMedia(args: MergeMediaType, task: Task) {
  return handleS3DownAndUpAppend({
    task: task,
    fileIds: args.fileIds,
    outputFile: `${nanoid(8)}.${args.outputFormat}`,
    operation: async ({ inputPaths, outputPath }) => {
      const listFile = path.join(TEMP_DIR, `${task.code}_concat.txt`);
      const listContent = inputPaths.map(p => `file '${p}'`).join('\n');
      await Bun.write(listFile, listContent);

      const { error } = await tryCatch(
        runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath], task)
      );
      await cleanupFile(listFile);
      if (error) throw error;
    },
  });
}

export async function extractThumbnail(args: ExtractThumbnailType, task: Task) {
  return handleS3DownAndUpAppend({
    task,
    fileIds: [args.fileId],
    outputFile: `${nanoid(8)}.${args.imageFormat}`,
    operation: ({ inputPaths, outputPath }) => {
      return runFFmpeg(['-i', inputPaths[0]!, '-ss', args.timestamp, '-vframes', '1', outputPath], task);
    },
  });
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
  await cleanupFile(inputPath);

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

async function getVideoDuration(filePath: string) {
  const response = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  return parseFloat(response.text().trim());
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
    size: format?.size ? parseInt(format.size, 10) : null,
    duration: format?.duration ? parseFloat(format.duration) : null,
    bit_rate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
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
    size: format?.size ? parseInt(format.size, 10) : null,
    duration: format?.duration ? parseFloat(format.duration) : null,
    bit_rate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
    sample_rate: stream?.sample_rate ? parseInt(stream.sample_rate, 10) : null,
    channels: stream?.channels ?? null,
  };
}

export function getAudioEncodingParams(format: AudioFormat): string[] {
  switch (format.toLowerCase()) {
    case "mp3":
      return ["-acodec", "libmp3lame", "-q:a", "2"]; // Good quality
    case "aac":
    case "m4a":
      return ["-acodec", "aac", "-b:a", "192k"]; // Bitrate encoding
    case "wav":
      return ["-acodec", "pcm_s16le"]; // Raw WAV audio
    case "flac":
      return ["-acodec", "flac"];
    case "opus":
      return ["-acodec", "libopus", "-b:a", "128k"];
    default:
      throw new Error(`Unsupported audio format: ${format}`);
  }
}

async function runFFmpeg(args: string[], task: Task) {
  logOperation( JSON.stringify(["ffmpeg", ...args]));

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

export function logOperation( message: string) {
  console.log(`------- FFmpeg: ------------`);
  console.log(message);
  console.log(' ');
}
