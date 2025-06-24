import { tryCatch } from './promises.ts';
import { nanoid } from 'nanoid';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
type BgTask = { id: string; op: () => Promise<void> };
const activeTasks = new Set<string>();
const tasks: BgTask[] = [];
let shouldRun = false;

export function startBgQueue() {
  console.log("Background Queue started.");
  shouldRun = true;
  void runBgQueueLoop();
}

export function stopBgQueue() {
  shouldRun = false;
  tasks.length = 0;
  activeTasks.clear();
}

async function runBgQueueLoop() {
  while (shouldRun) {
    await tryCatch(executePass());

    const hasPendingTasks = tasks.length > 0;
    if (!hasPendingTasks) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function executePass() {
  if (activeTasks.size >= MAX_CONCURRENT_TASKS || tasks.length === 0) return;

  const availableSlots = MAX_CONCURRENT_TASKS - activeTasks.size;
  const tasksToExecute = tasks.slice(availableSlots);
  for (const task of tasksToExecute) {
    void executeTask(task);
  }
}

async function executeTask(task: BgTask) {
  activeTasks.add(task.id);
  const { error } = await tryCatch(task.op());
  if (error) {
    console.error('Failed to execute bg task');
    console.error(error);
  }
  activeTasks.delete(task.id);
}

export function after(task: () => Promise<void>) {
  tasks.push({ id: nanoid(8), op:task });
}
