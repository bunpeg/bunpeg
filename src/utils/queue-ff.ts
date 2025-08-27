import { tryCatch } from './promises.ts';
import { getNextPendingTasks, markPendingTasksForFileAsUnreachable, type Task, updateTask } from './tasks.ts';
import {
  addAudioTrack,
  asrAnalyze,
  asrNormalize,
  asrSegment,
  cutEnd,
  extractAudio,
  extractThumbnail,
  generateDashFiles,
  mergeMedia,
  removeAudio,
  resizeVideo,
  transcode,
  trim,
  visionAnalyze,
  visionSegment,
} from './ffmpeg.ts';
import {
  AddAudioTrackSchema,
  AsrAnalyzeSchema,
  AsrNormalizeSchema,
  AsrSegmentSchema,
  CutEndSchema,
  DashSchema,
  ExtractAudioSchema,
  ExtractThumbnailSchema,
  MergeMediaSchema,
  RemoveAudioSchema,
  ResizeVideoSchema,
  TranscodeSchema,
  TrimSchema,
  VisionAnalyzeSchema,
  VisionSegmentSchema,
} from './schemas.ts';

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
    await tryCatch(executePass());
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function executePass() {
  // Start as many tasks as possible up to the concurrency limit
  if (shouldRun && activeTasks.size < MAX_CONCURRENT_TASKS) {
    const availableSlots = MAX_CONCURRENT_TASKS - activeTasks.size;
    const tasks = await getNextPendingTasks({ excludeFileIds: Array.from(lockedFiles), limit: availableSlots });
    // console.log('tasks', tasks.map(t => ({ id: t.id, operation: t.operation })));
    if (tasks.length === 0) return;

    /**
     * scan the tasks to run for duplicate file_ids and remove them
     * the type `Map<string, number>` represents `Map<file_id, task_id>`
     */
    const temp_record = new Map<string, number>();
    for (const t of tasks) {
      if (!temp_record.has(t.file_id)) {
        temp_record.set(t.file_id, t.id);
      }
    }

    const temp_task_ids = Array.from(temp_record.values());
    const single_tasks = tasks.filter(t => temp_task_ids.includes(t.id));


    for (const task of single_tasks) {
      void start_task(task);
    }
  }
}

async function start_task(task: Task) {
  logQueueMessage(`Picking up task: ${task.id} to ${task.operation}`);
  updateTask(task.id, { status: 'processing' });
  activeTasks.add(task.id);
  lockedFiles.add(task.file_id);

  const { error: operationError } = await tryCatch(runOperation(task));
  if (operationError) {
    await updateTask(task.id, { status: "failed", error: operationError.message });
    // await updateTask(task.id, { status: "failed", error: encodeURI(operationError.message) });
    await markPendingTasksForFileAsUnreachable(task.file_id);
    logQueueError(`Failed to process task: ${task.id}`, operationError);
  } else {
    await updateTask(task.id, { status: 'completed' });
  }

  activeTasks.delete(task.id);
  lockedFiles.delete(task.file_id);

  // After finishing, try to fill the slot again
  if (shouldRun) {
    void executePass();
  }
}

async function runOperation(task: Task) {
  const { args: jsonArgs } = task;

  switch (task.operation) {
    case 'transcode': {
      const parsed = TranscodeSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid transcode args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await transcode(args, task);
    } break;

    case 'resize-video': {
      const parsed = ResizeVideoSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid resize-video args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await resizeVideo(args, task);
    } break;

    case 'trim': {
      const parsed = TrimSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid trim args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await trim(args, task);
    } break;

    case 'trim-end': {
      const parsed = CutEndSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid trim-end args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await cutEnd(args, task);
    } break;

    case 'extract-audio': {
      const parsed = ExtractAudioSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid extract-audio args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await extractAudio(args, task);
    } break;

    case 'remove-audio': {
      const parsed = RemoveAudioSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid remove-audio args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await removeAudio(args, task);
    } break;

    case 'add-audio': {
      const parsed = AddAudioTrackSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid add-audio-track args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await addAudioTrack(args, task);
    } break;

    case 'extract-thumbnail': {
      const parsed = ExtractThumbnailSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid extract-thumbnail args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await extractThumbnail(args, task);
    } break;

    case 'merge-media': {
      const parsed = MergeMediaSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid merge-media args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await mergeMedia(args, task);
    } break;

    case 'dash': {
      const parsed = DashSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid merge-media args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await generateDashFiles(args, task);
    } break;

    case 'asr-normalize': {
      const parsed = AsrNormalizeSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid asr-normalize args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await asrNormalize({ ...args, file_id: task.file_id }, task);
    } break;

    case 'asr-analyze': {
      const parsed = AsrAnalyzeSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid asr-analyze args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await asrAnalyze({ ...args, file_id: task.file_id }, task);
    } break;

    case 'asr-segment': {
      const parsed = AsrSegmentSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid asr-segment args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await asrSegment({ ...args, file_id: task.file_id }, task);
    } break;

    case 'vision-analyze': {
      const parsed = VisionAnalyzeSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid vision-analyze args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await visionAnalyze({ ...args, file_id: task.file_id }, task);
    } break;

    case 'vision-segment': {
      const parsed = VisionSegmentSchema.safeParse(JSON.parse(jsonArgs));
      if (!parsed.success) throw new Error(`Invalid vision-segment args: ${JSON.stringify(parsed.error.issues)}`);
      const args = parsed.data;
      await visionSegment({ ...args, file_id: task.file_id }, task);
    } break;

    default:
      throw new Error(`Unhandled operation: ${task.operation}`);
  }
}

function logQueueMessage(message: string) {
  console.log(`------- FFmpeg queue ------------`);
  console.log(message);
  console.log(' ');
}

function logQueueError(message: string, error: Error) {
  console.log(`------- FFmpeg queue error ------------`);
  console.log(message);
  console.error(error);
  console.log(' ');
}
