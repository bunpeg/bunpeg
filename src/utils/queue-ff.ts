import { getNextPendingTask, logTask, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks.ts';
import { getFile } from './files.ts';
import { cutEnd, extractAudio, transcode, trim } from './ffmpeg.ts';
import type { CutEndOperation, ExtractAudioOperation, TranscodeOperation, TrimOperation } from '../schemas.ts';
import { tryCatch } from './promises.ts';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);

const activeTasks = new Set<string>();
const lockedFiles = new Set<string>();

export async function startFFQueue() {
  console.log("FFmpeg Queue started. Max concurrency:", MAX_CONCURRENT_TASKS);

  while (true) {
    logQueueMessage(`executing pass | active tasks: ${lockedFiles.size} | locked files: ${lockedFiles.size}`);
    if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
      logQueueMessage('queue maxed out, going to sleep...')
      await Bun.sleep(1000); // allow time for running tasks to finish
      continue;
    }

    // TODO: fetch multiple tasks (depending on availability of the queue) and start them all
    const task = await getNextPendingTask({ excludeFileIds: Array.from(lockedFiles) });
    if (!task) {
      logQueueMessage('no pending task found, going to sleep...');
      await Bun.sleep(1000);
      continue;
    }

    logQueueMessage(`Picking up task: ${task.id} to ${task.operation}`);
    const { error } = await tryCatch(updateTask(task.id, { status: 'processing' }));
    if (error) {
      logQueueMessage(`Failed to update task ${task.id} start processing, skipping cycle...`);
      await Bun.sleep(1000);
      continue;
    }

    // Track task
    activeTasks.add(task.id);
    lockedFiles.add(task.file_id);

    runOperation(task.operation, task.args, task.file_id, task.id)
      .catch(async (error) => {
        logQueueMessage( `Failed to process task: ${task.id}`);
        console.error(error);
        await markPendingTasksForFileAsUnreachable(task.file_id);
        await removeTaskFromQueue(task.id);
        await removeFileLock(task.file_id);
      });

    console.log('completed cycle, restarting...');
  }
}

export async function removeTaskFromQueue(taskId: string) {
  activeTasks.delete(taskId);
}

export async function removeFileLock(fileId: string) {
  lockedFiles.delete(fileId);
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

function logQueueMessage(message: string) {
  console.log(`------- FFmpeg queue ------------`);
  console.log(message);
  console.log('----------END---------');
}
