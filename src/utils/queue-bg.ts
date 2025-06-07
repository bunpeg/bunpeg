const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
const tasks: (() => Promise<void>)[] = [];
let timerRef: NodeJS.Timeout;

export async function startBgQueue() {
  console.log("Background Queue started.");
  timerRef = setInterval(executePass, 1000);
}

export async function stopBgQueue() {
  if (timerRef) clearInterval(timerRef);
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
