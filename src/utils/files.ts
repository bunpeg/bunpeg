import { sql } from 'bun';

export interface UserFile {
  id: string;
  file_name: string;
  file_path: string;
  mime_type: string;
  metadata?: string | null;
}

export async function getFile(fileId: string) {
  const query = await sql`SELECT * FROM files WHERE id = ${fileId}`;
  return query[0] as UserFile | undefined;
}

export async function createFile(newFile: Exclude<UserFile, 'metadata'>) {
  await sql`INSERT INTO files ${sql(newFile)}`;
}

export async function updateFile(fileId: string, file: Partial<Exclude<UserFile, 'id'>>) {
  await sql`UPDATE files SET ${sql(file)} WHERE id = ${fileId}`;
}

export async  function deleteFile(fileId: string) {
  await sql`DELETE FROM files WHERE id = ${fileId}`;
}
