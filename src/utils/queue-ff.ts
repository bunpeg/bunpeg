import { getNextPendingTask, logTask, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks.ts';
import { getFile } from './files.ts';
import { cutEnd, extractAudio, transcode, trim } from './ffmpeg.ts';
import type { CutEndOperation, ExtractAudioOperation, TranscodeOperation, TrimOperation } from '../schemas.ts';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);

const activeTasks = new Set<string>();
const activeFiles = new Set<string>();

export async function startFFQueue() {
  console.log("FFmpeg Queue started. Max concurrency:", MAX_CONCURRENT_TASKS);

  while (true) {
    if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
      await Bun.sleep(500); // allow time for running tasks to finish
      continue;
    }

    const task = await getNextPendingTask({ excludeFileIds: Array.from(activeFiles) });
    if (!task) {
      await Bun.sleep(500);
      continue;
    }

    logTask(task.id, `Starting to ${task.operation}`);
    await updateTask(task.id, { status: 'processing' });

    // Track task
    activeTasks.add(task.id);
    activeFiles.add(task.file_id);

    runOperation(task.operation, task.args, task.file_id, task.id)
      .catch((error) => {
        logTask(task.id, 'Failed to process');
        console.error(error);
        return markPendingTasksForFileAsUnreachable(task.file_id);
      })
      .finally(() => {
        activeTasks.delete(task.id);
        activeFiles.delete(task.file_id);
        logTask(task.id, 'Finished processing');
      });
  }
}

async function runOperation(operation: Task['operation'], jsonArgs: string, fileId: string, taskId: string) {
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
