import { tryCatch } from './promises.ts';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
const tasks: (() => Promise<void>)[] = [];
let shouldRun = false;
let runningTasks = 0;

export function startBgQueue() {
  console.log("Background Queue started.");
  shouldRun = true;
  void runBgQueueLoop();
}

export function stopBgQueue() {
  shouldRun = false;
  tasks.length = 0;
  runningTasks = 0;
}

async function runBgQueueLoop() {
  while (shouldRun) {
    await tryCatch(executePass());
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function executePass() {
  if (runningTasks >= MAX_CONCURRENT_TASKS || tasks.length === 0) return;

  const task = tasks.shift();
  if (!task) return;

  try {
    runningTasks++;
    await task();
  } catch (error) {
    console.error('Failed to execute bg task');
    console.error(error);
  } finally {
    runningTasks--;
  }
}

export function after(task: () => Promise<void>) {
  tasks.push(task);
}
