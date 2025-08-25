import type { OperationName, Operations } from './schemas.ts';
import { nanoid } from 'nanoid';
import { sql } from 'bun';
import type { UserFile } from './files.ts';

export interface Task {
  id: number;
  code: string;
  file_id: string;
  operation: OperationName;
  args: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unreachable';
  pid?: number;
  error?: string;
}

export async function getTasksForFile(fileId: UserFile['id']) {
  return (await sql`SELECT * FROM tasks WHERE file_id = ${fileId} ORDER BY id`) as Task[];
}

export async function getTasksForFileAndDecendants(fileId: UserFile['id']) {
  const files = await sql`SELECT id FROM files WHERE id = ${fileId} OR parent = ${fileId}`;
  return (
    await sql`SELECT * FROM tasks WHERE file_id IN ${sql((files as UserFile[]).map((f) => ({ id: f.id })), 'id')} ORDER BY id`
  ) as Task[];
}


export async function getNextPendingTasks(params: { excludeFileIds: string[], limit: number }) {
  if (params.excludeFileIds.length === 0) {
    const query = await sql`
      SELECT *
      FROM tasks
      WHERE status = 'queued'
      ORDER BY id
      LIMIT ${params.limit}`;
    return query as Task[];
  }

  const query = await sql`
    SELECT *
    FROM tasks
    WHERE status = 'queued' AND file_id NOT IN ${sql(params.excludeFileIds.map((id) => ({ id })), 'id')}
    ORDER BY id
    LIMIT ${params.limit}`;
  return query as Task[];
}

export async function createTask(fileId: UserFile['id'], operation: Task['operation'], args: Operations) {
  await sql`INSERT INTO tasks ${sql({
    code: nanoid(8),
    file_id: fileId,
    status: 'queued',
    operation,
    args: JSON.stringify(args),
  })}`
}

export async function bulkCreateTasks(tasks: { file_id: UserFile['id'], operation: Task['operation'], args: Operations }[]) {
  const dbInput = tasks.map((t) => ({
    code: nanoid(8),
    file_id: t.file_id,
    status: 'queued',
    operation: t.operation,
    args: JSON.stringify(t.args),
  }))

  await sql`INSERT INTO tasks ${sql(dbInput)}`
}

export async function updateTask(taskId: Task['id'], task: Partial<Omit<Task, 'id'>>) {
  await sql`UPDATE tasks SET ${sql(task)} WHERE id = ${taskId}`;
}

export async function markPendingTasksForFileAsUnreachable(fileId: Task['file_id']) {
  await sql`UPDATE tasks SET status = 'unreachable' WHERE file_id = ${fileId} and status = 'queued'`;
}

export async function deleteAllTasksForFile(fileId: Task['file_id']) {
  await sql`DELETE FROM tasks WHERE file_id = ${fileId}`;
}

export async function restoreAllProcessingTasksToQueued() {
  await sql`UPDATE tasks SET status = 'queued' WHERE status = 'processing'`;
}

export function logTask(taskId: Task['id'], message: string) {
  console.log(`------- Task: ${taskId} ------------`);
  console.log(message);
  console.log(' ');
}
