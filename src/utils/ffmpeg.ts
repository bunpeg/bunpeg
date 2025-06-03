import { $ } from 'bun';
import path from "path";
import { getTask, type Task, updateTask } from './tasks';
import { getFile, updateFile } from './files';
import type {
  ChainType,
  CutEndOperation,
  ExtractAudioOperation,
  TranscodeOperation,
  TrimOperation,
} from '../schemas.ts';

const outputDir = "./data/bucket";

export function transcode(inputPath: string, outputFormat: string, taskId: string) {
  const outputPath = path.join(outputDir, `${taskId}.${outputFormat}`);
  runFFmpeg(["-i", inputPath, outputPath], taskId, outputPath);
}

export function trim(inputPath: string, start: string, duration: string, outputFormat: string, taskId: string) {
  const outputPath = path.join(outputDir, `${taskId}.${outputFormat}`);
  runFFmpeg(["-i", inputPath, "-ss", start, "-t", duration, "-c", "copy", outputPath], taskId, outputPath);
}

export function extractAudio(inputPath: string, audioFormat: string, taskId: string) {
  const outputPath = path.join(outputDir, `${taskId}.${audioFormat}`);
  runFFmpeg(["-i", inputPath, "-vn", "-acodec", "copy", outputPath], taskId, outputPath);
}

export async function cutEnd(inputPath: string, duration: string, outputFormat: string, taskId: string) {
  const totalDuration = await getVideoDuration(inputPath);
  const keepDuration = totalDuration - parseFloat(duration);
  if (keepDuration <= 0) throw new Error("Resulting video would be empty");

  const outputPath = path.join(outputDir, `${taskId}.${outputFormat}`);
  runFFmpeg(["-i", inputPath, "-t", keepDuration.toFixed(2), "-c", "copy", outputPath], taskId, outputPath);
}

export async function getVideoDuration(filePath: string) {
  const response = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  return parseFloat(response.text().trim());
}

export async function runOperation(operation: Task['operation'], jsonArgs: string, fileId: string, taskId: string) {
  const userFile = getFile(fileId);
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

function runFFmpeg(args: string[], taskId: string, outputPath: string) {
  const task = getTask(taskId);

  if (!task) throw new Error(`Task ${taskId} not found!`);

  const ffmpeg = Bun.spawn(["ffmpeg", ...args], {
    onExit(_, exitCode: number | null) {
      if (exitCode === 0) {
        updateTask(taskId, { status: "completed" });
        updateFile(task.file_id, { file_path: outputPath });
      } else {
        updateTask(taskId, { status: "failed", error: `FFmpeg exited with code ${exitCode}` });
      }
    }
  });

  updateTask(taskId, { status: "processing", pid: ffmpeg.pid });
}
