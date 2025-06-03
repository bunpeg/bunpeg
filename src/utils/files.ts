import { connectDb } from './db.ts';

export interface UserFile {
  id: string;
  file_name: string;
  file_path: string;
}

export function getFile(fileId: string) {
  using db = connectDb();
  using query = db.query<UserFile, string>('SELECT * FROM files WHERE id = ?');
  return query.get(fileId);
}

export function createFile(fileId: string, fileName: string, filePath: string) {
  using db = connectDb();
  using query = db.query('INSERT INTO files (id, file_name, file_path) VALUES (?, ?, ?)');
  query.run(fileId, fileName, filePath);
}

export function updateFile(fileId: string, file: Partial<Exclude<UserFile, 'id'>>) {
  const params = Object.keys(file).map(key => file[key as keyof UserFile]!);
  const setParams = Object.keys(file).map((key) => `${key} = ?`).join(', ');

  using db = connectDb();
  using query = db.query(`UPDATE files SET ${setParams} WHERE id = $id`);
  query.run(...params, fileId)
}
