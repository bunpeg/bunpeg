import { getNextPendingTask, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks.ts';
import { getFile } from './files.ts';
import { cutEnd, extractAudio, transcode, trim } from './ffmpeg.ts';
import type { CutEndOperation, ExtractAudioOperation, TranscodeOperation, TrimOperation } from '../schemas.ts';
import { tryCatch } from './promises.ts';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);

const activeTasks = new Set<string>();
const lockedFiles = new Set<string>();
let shouldRun = false;

export function startFFQueue() {
  logQueueMessage(`Started Queue with max concurrency: ${MAX_CONCURRENT_TASKS}`);
  shouldRun = true;
  runQueueLoop();
}

export function stopFFQueue() {
  shouldRun = false;
  activeTasks.clear();
  lockedFiles.clear();
}

async function runQueueLoop() {
  while (shouldRun) {
    await executePass();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function executePass() {
  logQueueMessage(`executing pass | active tasks: ${lockedFiles.size} | locked files: ${lockedFiles.size}`);
  if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
    logQueueMessage('queue maxed out, going to sleep...')
    return;
  }

  // TODO: fetch multiple tasks (depending on availability of the queue) and start them all
  const task = await getNextPendingTask({ excludeFileIds: Array.from(lockedFiles) });
  if (!task) {
    logQueueMessage('no pending task found, going to sleep...');
    return;
  }

  logQueueMessage(`Picking up task: ${task.id} to ${task.operation}`);
  const { error } = await tryCatch(updateTask(task.id, { status: 'processing' }));
  if (error) {
    logQueueMessage(`Failed to update task ${task.id} start processing, skipping cycle...`);
    return;
  }

  // Track task
  activeTasks.add(task.id);
  lockedFiles.add(task.file_id);

  try {
    await runOperation(task.operation, task.args, task.file_id, task.id);
  } catch (error) {
    logQueueMessage(`Failed to process task: ${task.id}`);
    console.error(error);
    await markPendingTasksForFileAsUnreachable(task.file_id);
    await removeTaskFromQueue(task.id);
    await removeFileLock(task.file_id);
  }

  console.log('completed cycle, restarting...');
}

export async function removeTaskFromQueue(taskId: string) {
  logQueueMessage(`Removing task ${taskId} from queue`);
  activeTasks.delete(taskId);
}

export async function removeFileLock(fileId: string) {
  logQueueMessage(`Removing file lock ${fileId}`);
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
      await transcode(inputPath, args.format, taskId);
    } break;
    case 'trim': {
      const args = JSON.parse(jsonArgs) as TrimOperation;
      await trim(inputPath, args.start, args.duration, args.outputFormat, taskId);
    }  break;
    case 'cut-end': {
      const args = JSON.parse(jsonArgs) as CutEndOperation;
      await cutEnd(inputPath, args.duration, args.outputFormat, taskId);
    } break;
    case 'extract-audio': {
      const args = JSON.parse(jsonArgs) as ExtractAudioOperation;
      await extractAudio(inputPath, args.audioFormat, taskId);
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
