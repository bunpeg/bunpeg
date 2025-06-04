import { connectDb } from './db.ts';
import type { Operations } from '../schemas.ts';
import { nanoid } from 'nanoid';

export interface Task {
  id: string;
  file_id: string;
  operation: 'transcode' | 'trim' | 'cut-end' | 'extract-audio';
  args: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unreachable';
  pid?: number;
  error?: string;
}

export function getTask(taskId: string) {
  using db = connectDb();
  using query = db.query<Task, string>('SELECT * FROM tasks WHERE id = ?');
  return query.get(taskId);
}

export function getNextPendingTask(params: { excludeFileIds: string[] }) {
  using db = connectDb();
  using query = db.query<Task, string[]>(`
    SELECT * FROM tasks
    WHERE status = ?
    ${params.excludeFileIds.length > 0 ? `AND file_id NOT IN (${params.excludeFileIds.map(() => '?').join(', ')}` : ' '}
    LIMIT 1
  `);

  return query.get('queued', ...params.excludeFileIds) ;
}

export function getTasksForFile(fileId: string) {
  using db = connectDb();
  using query = db.query<Task, string>('SELECT * FROM tasks WHERE file_id = ?');
  return query.all(fileId);
}

export function createTask(fileId: string, operation: Task['operation'], args: Operations, chainId?: string) {
  using db = connectDb();
  using query = db.query('INSERT INTO tasks (id, file_id, status, operation, args) VALUES (?, ?, ?, ?, ?)');
  query.run(nanoid(8), fileId, 'queued', operation, JSON.stringify(args));
}

export function updateTask(taskId: string, task: Partial<Exclude<Task, 'id'>>) {
  const params = Object.keys(task).map((key) => task[key as keyof Task]!);
  const setParams = Object.keys(task).map((key) => `${key} = ?`).join(', ');

  using db = connectDb();
  using query = db.query(`UPDATE tasks SET ${setParams} WHERE id = ?`);
  query.run(...params, taskId)
}

export function markPendingTasksAsUnreachableForFile(fileId: string) {
  using db = connectDb();
  using query = db.query<Task, string[]>('UPDATE tasks SET status = ? WHERE file_id = ? and status = ?');
  return query.all('unreachable', fileId, 'queued');
}

export function deleteAllTasksForFile(fileId: string) {
  using db = connectDb();
  using  query = db.query('DELETE FROM tasks WHERE file_id = ?');
  query.run(fileId);
}
