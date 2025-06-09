import { getNextPendingTask, markPendingTasksForFileAsUnreachable, updateTask, type Task } from './tasks.ts';
import { getFile, type UserFile } from './files.ts';
import { cutEnd, extractAudio, transcode, trim, mergeMedia, addAudioTrack, removeAudio, resizeVideo, extractThumbnail } from './ffmpeg.ts';
import type { CutEndOperation, ExtractAudioOperation, TranscodeOperation, TrimOperation, MergeMediaOperation, AddAudioTrackOperation, RemoveAudioOperation, ResizeVideoOperation, ExtractThumbnailOperation } from '../schemas.ts';
import { tryCatch } from './promises.ts';
import {
  CutEndSchema,
  ExtractAudioSchema,
  TranscodeSchema,
  TrimSchema,
  MergeMediaSchema,
  AddAudioTrackSchema,
  RemoveAudioSchema,
  ResizeVideoSchema,
  ExtractThumbnailSchema,
} from '../schemas.ts';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);

const activeTasks = new Set<number>();
const lockedFiles = new Set<string>();
let shouldRun = false;

export function startFFQueue() {
  logQueueMessage(`Started Queue with max concurrency: ${MAX_CONCURRENT_TASKS}`);
  shouldRun = true;
  void runQueueLoop();
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
  // logQueueMessage(`executing pass | active tasks: ${lockedFiles.size} | locked files: ${lockedFiles.size}`);
  if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
    logQueueMessage('queue maxed out, going to sleep...')
    return;
  }

  // TODO: fetch multiple tasks (depending on availability of the queue) and start them all
  const task = await getNextPendingTask({ excludeFileIds: Array.from(lockedFiles) });
  if (!task) {
    // logQueueMessage('no pending task found, going to sleep...');
    return;
  }

  logQueueMessage(`Picking up task: ${task.id} to ${task.operation}`);

  const { error: taskError } = await tryCatch(updateTask(task.id, { status: 'processing' }));
  if (taskError) {
    console.error(taskError);
    logQueueMessage(`Failed to update task ${task.id} start processing, skipping cycle...`);
    return;
  }

  // Lock task & file
  activeTasks.add(task.id);
  lockedFiles.add(task.file_id);

  const { error: operationError } = await tryCatch(runOperation(task));
  if (operationError) {
    console.error(operationError);
    logQueueMessage(`Failed to process task: ${task.id}`);
    await markPendingTasksForFileAsUnreachable(task.file_id);
  }

  removeTaskFromQueue(task.id);
  removeFileLock(task.file_id);

  // console.log('completed cycle, restarting...');
}

export function removeTaskFromQueue(taskId: Task['id']) {
  logQueueMessage(`Removing task ${taskId} from queue`);
  activeTasks.delete(taskId);
}

export function removeFileLock(fileId: UserFile['id']) {
  logQueueMessage(`Removing file lock ${fileId}`);
  lockedFiles.delete(fileId);
}

async function runOperation(task: Task) {
  const { file_id, args: jsonArgs } = task;
  const userFile = await getFile(file_id);
  if (!userFile) {
    throw  new Error(`No user file found`);
  }

  const inputPath = userFile.file_path;
  switch (task.operation) {
    case 'transcode': {
      const parsed = TranscodeSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid transcode args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await transcode(inputPath, args.format, task);
    } break;
    case 'trim': {
      const parsed = TrimSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid trim args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await trim(inputPath, args.start, args.duration, args.outputFormat, task);
    }  break;
    case 'trim-end': {
      const parsed = CutEndSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid trim-end args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await cutEnd(inputPath, args.duration, args.outputFormat, task);
    } break;
    case 'extract-audio': {
      const parsed = ExtractAudioSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid extract-audio args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await extractAudio(inputPath, args.audioFormat, task);
    } break;
    case 'merge-media': {
      const parsed = MergeMediaSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid merge-media args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await mergeMedia(args.fileIds, args.outputFormat, task);
    } break;
    case 'add-audio-track': {
      const parsed = AddAudioTrackSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid add-audio-track args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await addAudioTrack(args.videoFileId, args.audioFileId, args.outputFormat, task);
    } break;
    case 'remove-audio': {
      const parsed = RemoveAudioSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid remove-audio args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await removeAudio(args.fileId, args.outputFormat, task);
    } break;
    case 'resize-video': {
      const parsed = ResizeVideoSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid resize-video args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await resizeVideo(args.fileId, args.width, args.height, args.outputFormat, task);
    } break;
    case 'extract-thumbnail': {
      const parsed = ExtractThumbnailSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid extract-thumbnail args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await extractThumbnail(args.fileId, args.timestamp, args.imageFormat, task);
    } break;
    default:
      throw new Error(`Unhandled operation: ${task.operation}`);
  }
}

function logQueueMessage(message: string) {
  console.log(`------- FFmpeg queue ------------`);
  console.log(message);
  console.log('----------END---------');
}
