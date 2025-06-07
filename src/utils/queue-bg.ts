const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
const tasks: (() => Promise<void>)[] = [];
let shouldRun = false;

export async function startBgQueue() {
  console.log("Background Queue started.");
  shouldRun = true;
  runBgQueueLoop();
}

export async function stopBgQueue() {
  shouldRun = false;
  tasks.length = 0;
}

async function runBgQueueLoop() {
  while (shouldRun) {
    await executePass();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function executePass() {
  if (tasks.length >= MAX_CONCURRENT_TASKS || tasks.length === 0) return;

  const task = tasks.shift();
  if (!task) return;

  try {
    await task();
  } catch (error) {
    console.error('Failed to execute bg task');
    console.error(error);
  }
}

export function after(task: () => Promise<void>) {
  tasks.push(task);
}
