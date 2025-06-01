import { serve, $ } from "bun";
import fs from "node:fs";
import { nanoid } from 'nanoid';

import docs from "./www/docs.html";
import upload from "./www/upload.html";
import { connectDb, initDb } from './utils/db';

const uploadDir = "./data/uploads";
const outputDir = "./data/outputs";

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

await initDb();

const server = serve({
  routes: {
    "/docs": docs,
    "/app": upload,
    "/ffmpeg/version": async () => {
      const output = await $`ffmpeg -version`.text();
      const parts = output.split("\n");
      return new Response(parts[0]);
    },
    "/upload": async (req) => {
      const formData = await req.formData();
      const __file = formData.get('file');
      if (!__file) throw new Error('Must upload a profile picture.');

      const fileId = nanoid(8);
      const file = __file as unknown as File;
      const parts = file.name.split('.');
      const extension = parts.pop();
      const extendedName = `${parts.join('.')}-${fileId}.${extension}`;

      using db = connectDb();
      using query = db.query('INSERT INTO files (id, file_name, upload_path) VALUES (?, ?, ?)');
      query.run(fileId, file.name, `${uploadDir}/${extendedName}`);

      await Bun.write(`${uploadDir}/${extendedName}`, file);

      return Response.json({ fileId }, { status: 200 });
    },
    "/download/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      using db = connectDb();
      using query = db.query<{ file_name: string; upload_path: string }, string>(
        'SELECT file_name, upload_path FROM files WHERE id = ?'
      );
      const dbFile = query.get(fileId);
      if (!dbFile?.file_name) throw new Error('Invalid file id');

      const file = Bun.file(dbFile.upload_path);

      return new Response(file, {
        headers: {
          'content-disposition': `attachment; filename="${dbFile.file_name}"`,
        },
      });
    },
    "/wipe": async () => {
      let count = 0;
      using db = connectDb();
      using query = db.query<{ upload_path: string }, string>('SELECT upload_path FROM files');
      for (const file of query) {
        const localFile = Bun.file(file.upload_path);

        if (await localFile.exists()) {
          await localFile.delete();
        }

        count++;
      }

      using delQuery = db.query('DELETE FROM files');
      delQuery.run();

      return new Response(`Volume wiped! (count: ${count})`);
    },
  },
  fetch() {
    return new Response("Hello from bunpeg!");
  },
  error(error) {
    console.error(error);
    return new Response(`Internal Error: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain",
      },
    });
  },
});

console.log(`Server started on ${server.url}`);
