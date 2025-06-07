import { connectDb } from './db.ts';
import type { Operations } from '../schemas.ts';
import { nanoid } from 'nanoid';
import { sql } from 'bun';

export interface Task {
  id: string;
  file_id: string;
  operation: 'transcode' | 'trim' | 'cut-end' | 'extract-audio';
  args: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unreachable';
  pid?: number;
  error?: string;
}

export async function getTask(taskId: string) {
  // using db = connectDb();
  // using query = db.query<Task, string>('SELECT * FROM tasks WHERE id = ?');
  // return query.get(taskId);

  const query = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
  return query[0] as Task | undefined;
}

export async function getNextPendingTask(params: { excludeFileIds: string[] }) {
  // using db = connectDb();
  // using query = db.query<Task, string[]>(`
  //   SELECT * FROM tasks
  //   WHERE status = ?
  //   ${params.excludeFileIds.length > 0 ? `AND file_id NOT IN (${params.excludeFileIds.map(() => '?').join(', ')}` : ' '}
  //   LIMIT 1
  // `);

  const fileIdsFilter = params.excludeFileIds.length > 0 ? sql`AND file_id NOT IN ${sql(params.excludeFileIds)}` : sql``;
  const query = await sql`
    SELECT *
    FROM tasks
    WHERE status = 'queued' ${fileIdsFilter}`;

  return query[0] as Task | undefined;
}

export async function getTasksForFile(fileId: string) {
  // using db = connectDb();
  // using query = db.query<Task, string>('SELECT * FROM tasks WHERE file_id = ?');
  // return query.all(fileId);

  return (await sql`SELECT * FROM tasks WHERE file_id = ${fileId}`) as Task[];
}

export async function createTask(fileId: string, operation: Task['operation'], args: Operations) {
  // using db = connectDb();
  // using query = db.query('INSERT INTO tasks (id, file_id, status, operation, args) VALUES (?, ?, ?, ?, ?)');
  // query.run(nanoid(8), fileId, 'queued', operation, JSON.stringify(args));

  await sql`INSERT INTO tasks ${sql({
    id: nanoid(8),
    file_id: fileId,
    status: 'queued',
    operation,
    args: JSON.stringify(args),
  })}`
}

export async function bulkCreateTasks(tasks: { fileId: string, operation: Task['operation'], args: Operations }[]) {
  const dbInput = tasks.map((t) => ({
    id: nanoid(8),
    file_id: t.fileId,
    status: 'queued',
    operation: t.operation,
    args: JSON.stringify(t.args),
  }))

  await sql`INSERT INTO tasks ${sql(dbInput)}`
}

export async function updateTask(taskId: string, task: Partial<Exclude<Task, 'id'>>) {
  // const params = Object.keys(task).map((key) => task[key as keyof Task]!);
  // const setParams = Object.keys(task).map((key) => `${key} = ?`).join(', ');
  //
  // using db = connectDb();
  // using query = db.query(`UPDATE tasks SET ${setParams} WHERE id = ?`);
  // query.run(...params, taskId)

  await sql`UPDATE tasks SET ${sql(task)} WHERE id = ${taskId}`;
}

export async function markPendingTasksForFileAsUnreachable(fileId: string) {
  // using db = connectDb();
  // using query = db.query<Task, string[]>('UPDATE tasks SET status = ? WHERE file_id = ? and status = ?');
  // return query.all('unreachable', fileId, 'queued');
  await sql`UPDATE tasks SET status = 'unreachable' WHERE id = ${fileId} and status = 'queued'`;
}

export async function deleteAllTasksForFile(fileId: string) {
  // using db = connectDb();
  // using  query = db.query('DELETE FROM tasks WHERE file_id = ?');
  // query.run(fileId);
  await sql`DELETE FROM tasks WHERE file_id = ${fileId}`;
}

export async function restoreAllProcessingTasksToQueued() {
  await sql`UPDATE tasks SET status = 'queued' WHERE status = 'processing'`;
}

export function logTask(taskId: string, message: string) {
  console.log('----------START---------');
  console.log('Task: ', taskId);
  console.log(message);
  console.log('---------END----------');
}
