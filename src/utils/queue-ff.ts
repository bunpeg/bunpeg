import { getNextPendingTask, markPendingTasksForFileAsUnreachable, updateTask } from './tasks.ts';
import { runOperation } from './ffmpeg.ts';

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

    // Mark as processing to lock it
    await updateTask(task.id, { status: 'processing' });

    // Track task
    activeTasks.add(task.id);
    activeFiles.add(task.file_id);

    runOperation(task.operation, task.args, task.file_id, task.id)
      .catch((error) => {
        console.error(error);
        return markPendingTasksForFileAsUnreachable(task.file_id);
      })
      .finally(() => {
        activeTasks.delete(task.id);
        activeFiles.delete(task.file_id);
      });
  }
}
