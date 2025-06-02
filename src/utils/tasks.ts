import { connectDb } from './db.ts';

interface Task {
  id: string;
  file_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  pid?: number;
  error?: string;
}

export function getTask(taskId: string) {
  using db = connectDb();
  using query = db.query<Task, string>('SELECT * FROM tasks WHERE id = ?');
  return query.get(taskId);
}

export function createTask(taskId: string, fileId: string) {
  using db = connectDb();
  using query = db.query('INSERT INTO tasks (id, file_id, status) VALUES (?, ?, ?)');
  query.run(taskId, fileId, 'processing'); // TODO: update the status to 'queued' when the queue exits
}

export function updateTask(taskId: string, task: Partial<Exclude<Task, 'id'>>) {
  // const params = Object.keys(task).reduce((acc, key) => ({ ...acc, [`\$${key}`]: task[key as keyof Task] }), {});
  const params = Object.values(task).map((key) => task[key as keyof Task]!);
  // const setParams = Object.keys(task).map((key) => `${key} = \$${key}`).join(', ');
  const setParams = Object.keys(task).map((key) => `${key} = ?`).join(', ');

  using db = connectDb();
  using query = db.query(`UPDATE tasks SET ${setParams} WHERE id = ?`);
  query.run(...params, taskId)
}
