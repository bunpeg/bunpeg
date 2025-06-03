import { connectDb } from './db.ts';
import type { Operations } from '../schemas.ts';
import { nanoid } from 'nanoid';

export interface Task {
  id: string;
  file_id: string;
  operation: 'transcode' | 'trim' | 'cut-end' | 'extract-audio';
  args: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  pid?: number;
  error?: string;
  chain_id?: string;
}

export function getTask(taskId: string) {
  using db = connectDb();
  using query = db.query<Task, string>('SELECT * FROM tasks WHERE id = ?');
  return query.get(taskId);
}

export function getNextPendingTask() {
  using db = connectDb();
  using query = db.query<Task, string>('SELECT * FROM tasks WHERE status = ? LIMIT 1');
  return query.get('queued');
}

export function createTask(fileId: string, operation: Task['operation'], args: Operations, chainId?: string) {
  using db = connectDb();
  using query = db.query('INSERT INTO tasks (id, file_id, status, operation, args, chain_id) VALUES (?, ?, ?, ?, ?, ?)');
  query.run(nanoid(8), fileId, 'queued', operation, JSON.stringify(args), chainId ?? null);
}

export function updateTask(taskId: string, task: Partial<Exclude<Task, 'id'>>) {
  const params = Object.keys(task).map((key) => task[key as keyof Task]!);
  const setParams = Object.keys(task).map((key) => `${key} = ?`).join(', ');

  using db = connectDb();
  using query = db.query(`UPDATE tasks SET ${setParams} WHERE id = ?`);
  query.run(...params, taskId)
}
