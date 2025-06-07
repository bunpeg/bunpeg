import { $ } from 'bun';
import path from "path";
import { getTask, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks';
import { getFile, updateFile } from './files';
import type {
  CutEndOperation,
  ExtractAudioOperation,
  TranscodeOperation,
  TrimOperation,
} from '../schemas.ts';
import { downloadFromS3ToDisk, spaces, uploadToS3FromDisk } from './s3.ts';

const tempDir = "./data/temp";

export async function runOperation(operation: Task['operation'], jsonArgs: string, fileId: string, taskId: string) {
  const userFile = await getFile(fileId);
  if (!userFile) {
    throw  new Error(`No user file found`);
  }

  const inputPath = userFile.file_path;
  switch (operation) {
    case 'transcode': {
      const args = JSON.parse(jsonArgs) as TranscodeOperation;
      transcode(inputPath, args.format, taskId);
    } break;
    case 'trim': {
      const args = JSON.parse(jsonArgs) as TrimOperation;
      trim(inputPath, args.start, args.duration, args.outputFormat, taskId);
    }  break;
    case 'cut-end': {
      const args = JSON.parse(jsonArgs) as CutEndOperation;
      await cutEnd(inputPath, args.duration, args.outputFormat, taskId);
    } break;
    case 'extract-audio': {
      const args = JSON.parse(jsonArgs) as ExtractAudioOperation;
      extractAudio(inputPath, args.audioFormat, taskId);
    } break;
    default:
      throw new Error(`Unhandled operation: ${operation}`);
  }
}

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

async function runFFmpeg(args: string[], taskId: string) {
  const task = await getTask(taskId);

  if (!task) throw new Error(`Task ${taskId} not found!`);

  const ffmpeg = Bun.spawn(["ffmpeg", ...args], {
    timeout: 1000 * 60 * 15, // 15 minutes
    onExit: async (_sub, exitCode: number | null, sigCode) => {
      if (exitCode === 0) {
        await updateTask(taskId, { status: "completed" });
      } else {
        await updateTask(taskId, { status: "failed", error: `FFmpeg exited with code: ${exitCode} & signal ${sigCode}` });
        await markPendingTasksForFileAsUnreachable(task.file_id);
      }
    }
  });

  await updateTask(taskId, { status: "processing", pid: ffmpeg.pid });
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

   await updateFile(task.file_id, { file_path: outputPath });
   const s3File = spaces.file(s3Path);
   await s3File.delete();

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
