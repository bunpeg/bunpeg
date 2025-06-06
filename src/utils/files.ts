import { sql } from 'bun';

export interface UserFile {
  id: string;
  file_name: string;
  file_path: string;
}

export async function getFile(fileId: string) {
  const query = await sql`SELECT * FROM files WHERE id = ${fileId}`;
  return query[0] as UserFile | undefined;
}

export async function createFile(fileId: string, fileName: string, filePath: string) {
  await sql`INSERT INTO files ${sql({ id: fileId, file_name: fileName, file_path: filePath })}`;
}

export async function updateFile(fileId: string, file: Partial<Exclude<UserFile, 'id'>>) {
  await sql`UPDATE files SET ${sql(file)} WHERE id = ${fileId}`;
}

export async  function deleteFile(fileId: string) {
  await sql`DELETE FROM files WHERE id = ${fileId}`;
}
