import path from "path";
import { getTask, updateTask } from './tasks.ts';
import { updateFile } from './files.ts';

const outputDir = "./data/outputs";

export function transcode(inputPath: string, outputFormat: string, taskId: string) {
  const outputPath = path.join(outputDir, `${taskId}.${outputFormat}`);
  return runFFmpeg(["-i", inputPath, outputPath], taskId, outputPath);
}

export function trim(inputPath: string, start: string, duration: string, outputFormat: string, taskId: string) {
  const outputPath = path.join(outputDir, `${taskId}.${outputFormat}`);
  return runFFmpeg(["-i", inputPath, "-ss", start, "-t", duration, "-c", "copy", outputPath], taskId, outputPath);
}

export function extractAudio(inputPath: string, audioFormat: string, taskId: string) {
  const outputPath = path.join(outputDir, `${taskId}.${audioFormat}`);
  return runFFmpeg(["-i", inputPath, "-vn", "-acodec", "copy", outputPath], taskId, outputPath);
}

function runFFmpeg(args: string[], taskId: string, outputPath: string) {
  const task = getTask(taskId);

  if (!task) throw new Error(`Task ${taskId} not found!`);

  const ffmpeg = Bun.spawn(["ffmpeg", ...args], {
    onExit(_, exitCode: number | null) {
      if (exitCode === 0) {
        updateTask(taskId, { status: "completed" });
        updateFile(task.file_id, { output_path: outputPath });
      } else {
        updateTask(taskId, { status: "failed", error: `FFmpeg exited with code ${exitCode}` });
      }
    }
  });

  updateTask(taskId, { status: "processing", pid: ffmpeg.pid });
}
