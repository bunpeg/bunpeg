import { getNextPendingTask, updateTask } from './tasks.ts';
import { runOperation } from './ffmpeg.ts';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
const activeTasks = new Set<string>();

export async function startQueue() {
  console.log("🎬 Queue started. Max concurrency:", MAX_CONCURRENT_TASKS);

  while (true) {
    if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
      await Bun.sleep(500); // allow time for running tasks to finish
      continue;
    }

    const nextTask = getNextPendingTask();
    if (!nextTask) {
      await Bun.sleep(500);
      continue;
    }

    // Mark as processing to lock it
    updateTask(nextTask.id, { status: 'processing' });

    // Track task
    activeTasks.add(nextTask.id);

    runOperation(nextTask.operation, nextTask.args, nextTask.file_id, nextTask.id)
      .catch(console.error)
      .finally(() => activeTasks.delete(nextTask.id));
  }
}
