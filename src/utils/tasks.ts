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
  created_at: string;
}

export async function getTask(taskId: string) {
  const query = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
  return query[0] as Task | undefined;
}

export async function getNextPendingTask(params: { excludeFileIds: string[] }) {
  const fileIdsFilter = params.excludeFileIds.length > 0 ? sql`AND file_id NOT IN ${sql(params.excludeFileIds)}` : sql``;
  const query = await sql`
    SELECT *
    FROM tasks
    WHERE status = 'queued' ${fileIdsFilter}
    ORDER BY created_at`;

  return query[0] as Task | undefined;
}

export async function getTasksForFile(fileId: string) {
  return (await sql`SELECT * FROM tasks WHERE file_id = ${fileId} ORDER BY created_at`) as Task[];
}

export async function createTask(fileId: string, operation: Task['operation'], args: Operations) {
  await sql`INSERT INTO tasks ${sql({
    id: nanoid(8),
    file_id: fileId,
    status: 'queued',
    operation,
    args: JSON.stringify(args),
    created_at: new Date().toISOString()
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

export async function updateTask(taskId: string, task: Partial<Omit<Task, 'id'>>) {
  await sql`UPDATE tasks SET ${sql(task)} WHERE id = ${taskId}`;
}

export async function markPendingTasksForFileAsUnreachable(fileId: string) {
  await sql`UPDATE tasks SET status = 'unreachable' WHERE id = ${fileId} and status = 'queued'`;
}

export async function deleteAllTasksForFile(fileId: string) {
  await sql`DELETE FROM tasks WHERE file_id = ${fileId}`;
}

export async function restoreAllProcessingTasksToQueued() {
  await sql`UPDATE tasks SET status = 'queued' WHERE status = 'processing'`;
}

export function logTask(taskId: string, message: string) {
  console.log(`------- Task: ${taskId} ------------`);
  console.log(message);
  console.log('----------END---------');
}
