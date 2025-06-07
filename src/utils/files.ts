import { sql } from 'bun';

export interface UserFile {
  id: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  metadata?: string | null;
  created_at: string;
}

export async function getFile(fileId: string) {
  const query = await sql`SELECT * FROM files WHERE id = ${fileId}`;
  return query[0] as UserFile | undefined;
}

export async function createFile(newFile: Omit<UserFile, 'metadata' | 'created_at'>) {
  await sql`INSERT INTO files ${sql({ ...newFile, created_at: new Date().toISOString() })}`;
}

export async function updateFile(fileId: string, file: Partial<Omit<UserFile, 'id' | 'created_at'>>) {
  await sql`UPDATE files SET ${sql(file)} WHERE id = ${fileId}`;
}

export async  function deleteFile(fileId: string) {
  await sql`DELETE FROM files WHERE id = ${fileId}`;
}
