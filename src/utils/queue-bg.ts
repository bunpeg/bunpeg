import { tryCatch } from './promises.ts';
import { nanoid } from 'nanoid';

const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
type BgTask = { id: string; fn: () => Promise<void> };
const activeTasks = new Set<string>();
let tasks: BgTask[] = [];
let shouldRun = false;

export function startBgQueue() {
  logQueueMessage(`Started Queue with max concurrency: ${MAX_CONCURRENT_TASKS}`)
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function executePass() {
  if (activeTasks.size >= MAX_CONCURRENT_TASKS || tasks.length === 0) return;

  const activeTasksArr = Array.from(activeTasks);
  const idleTasks = tasks.filter(t => !activeTasksArr.includes(t.id));
  const nextSlots = Math.min(MAX_CONCURRENT_TASKS - activeTasks.size, idleTasks.length);
  const tasksToExecute = idleTasks.slice(0, nextSlots);
  for (const task of tasksToExecute) {
    void executeTask(task);
  }
}

async function executeTask(task: BgTask) {
  activeTasks.add(task.id);
  const { error } = await tryCatch(task.fn());
  if (error) {
    console.error('Failed to execute bg task');
    console.error(error);
  }
  activeTasks.delete(task.id);
  const taskIndex = tasks.findIndex(task => task.id === task.id);
  tasks.splice(taskIndex, 1);
}

export function after(fn: () => Promise<void>) {
  tasks.push({ id: nanoid(8), fn });
}

function logQueueMessage(message: string) {
  console.log(`------- BG queue ------------`);
  console.log(message);
  console.log(' ');
}

