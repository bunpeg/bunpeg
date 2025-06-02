import { connectDb } from './db.ts';

interface UserFile {
  id: string;
  file_name: string;
  upload_path: string;
  output_path:  string;
}

export function getFile(fileId: string) {
  using db = connectDb();
  using query = db.query<UserFile, string>('SELECT * FROM files WHERE id = ?');
  return query.get(fileId);
}

export function createFile(fileId: string, fileName: string, uploadPath: string) {
  using db = connectDb();
  using query = db.query('INSERT INTO files (id, file_name, upload_path) VALUES (?, ?, ?)');
  query.run(fileId, fileName, uploadPath);
}

export function updateFile(fileId: string, file: Partial<Exclude<UserFile, 'id'>>) {
  const params = Object.keys(file).map(key => file[key as keyof UserFile]!);
  const setParams = Object.keys(file).map((key) => `${key} = ?`).join(', ');

  using db = connectDb();
  using query = db.query(`UPDATE files SET ${setParams} WHERE id = $id`);
  query.run(...params, fileId)
}
