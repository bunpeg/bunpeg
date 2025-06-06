const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS);
const tasks: (() => Promise<void>)[] = [];

export async function startBgQueue() {
  console.log("Background Queue started.");

  while (true) {
    if (tasks.length >= MAX_CONCURRENT_TASKS || tasks.length === 0) {
      await Bun.sleep(500); // allow time for running tasks to finish
      continue;
    }

    const task = tasks.shift();
    if (!task) {
      await Bun.sleep(500);
      continue;
    }

    try {
      await task()
    } catch (error) {
      console.error('Failed to execute bg task', error);
    }
  }
}

export function after(task: () => Promise<void>) {
  tasks.push(task);
}
