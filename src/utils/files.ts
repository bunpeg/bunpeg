import { sql } from 'bun';

export interface UserFile {
  id: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  metadata?: string | null;
  parent?: string;
  created_at: string;
}

export async function getFile(fileId: UserFile['id']) {
  const [file] = await sql`SELECT * FROM files WHERE id = ${fileId}`;
  return file as UserFile | undefined;
}

export async function createFile(newFile: Omit<UserFile, 'metadata' | 'created_at'>) {
  await sql`INSERT INTO files ${sql({ ...newFile, created_at: new Date().toISOString() })}`;
}

export async function updateFile(fileId: UserFile['id'], file: Partial<Omit<UserFile, 'id' | 'created_at'>>) {
  await sql`UPDATE files SET ${sql(file)} WHERE id = ${fileId}`;
}

export async function deleteFile(fileId: UserFile['id']) {
  await sql`DELETE FROM files WHERE id = ${fileId} OR parent = ${fileId}`;
}

export async function checkFilesExist(fileIds: string[]): Promise<boolean> {
  if (fileIds.length === 0) return false;

  const rows = await sql`SELECT id FROM files WHERE id IN ${sql(fileIds.map((id) => ({ id })), 'id')}`;
  return rows.length === fileIds.length;
}
