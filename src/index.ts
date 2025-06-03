import { $, serve } from 'bun';
import fs from 'fs';
import { nanoid } from 'nanoid';

import docs from './www/docs.html';
import upload from './www/upload.html';

import { connectDb, initDb } from './utils/db';
import { createTask, getTask } from './utils/tasks.ts';
import { createFile, getFile } from './utils/files.ts';
import { ChainSchema, CutEndSchema, ExtractAudioSchema, TranscodeSchema, TrimSchema } from './schemas.ts';

const bucketDir = "./data/bucket";

fs.mkdirSync(bucketDir, { recursive: true });

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

    "/wipe": async () => {
      let count = 0;
      using db = connectDb();
      using filesQuery = db.query<{ upload_path: string; output_path: string; }, string>('SELECT upload_path, output_path FROM files');
      for (const file of filesQuery) {
        const inputFile = Bun.file(file.upload_path);
        const outputFile = Bun.file(file.output_path);

        if (await inputFile.exists()) {
          await inputFile.delete();
          count++;
        }

        if (await outputFile.exists()) {
          await outputFile.delete();
          count++;
        }
      }

      using filesDelQuery = db.query('DELETE FROM files');
      filesDelQuery.run();
      using tasksDelQuery = db.query('DELETE FROM tasks');
      tasksDelQuery.run();

      return new Response(`Volume wiped! (file count: ${count})`);
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

      createFile(fileId, file.name, `${bucketDir}/${extendedName}`);
      await Bun.write(`${bucketDir}/${extendedName}`, file);

      return Response.json({ fileId }, { status: 200 });
    },

    "/download/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const dbFile = getFile(fileId);
      if (!dbFile?.file_name) throw new Error('Invalid file id');

      const file = Bun.file(dbFile.file_path);

      return new Response(file, {
        headers: {
          'content-disposition': `attachment; filename="${dbFile.file_name}"`,
        },
      });
    },

    "/status/:taskId": async (req) => {
      const taskId = req.params.taskId;
      const task = getTask(taskId);
      return Response.json({ taskId, status: task?.status ?? 'unknown' },  { status: 200 });
    },

    "/transcode":  async (req) => {
      const parsed = TranscodeSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, format } = parsed.data;
      const file = getFile(fileId);

      if (!file || !fs.existsSync(file.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      createTask(fileId, 'transcode', { format });
      return Response.json({ success: true }, { status: 200 });
    },

    "/trim": async (req) => {
      const parsed = TrimSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, start, duration, outputFormat } = parsed.data;

      const userFile = getFile(fileId);
      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      createTask(fileId, 'trim', { start, duration, outputFormat });
      return Response.json({ success: true }, { status: 200 });
    },

    "/cut-end": async (req) => {
      const parsed = CutEndSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, duration, outputFormat } = parsed.data;

      const userFile = getFile(fileId);

      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response('File not found', { status: 400 });
      }

      createTask(fileId, 'cut-end', { duration, outputFormat });
      return Response.json({ success: true }, { status: 200 });
    },

    "/extract-audio": async (req) => {
      const parsed = ExtractAudioSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, audioFormat } = parsed.data;
      const userFile = getFile(fileId);

      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      createTask(fileId, 'extract-audio', { audioFormat });
      return Response.json({ success: true },  { status: 200 });
    },

    "/chain": async (req) => {
      const parsed = ChainSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, operations } = parsed.data;
      const userFile = getFile(fileId);
      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      for (const operation of operations) {
        const { type, ...args } = operation;
        createTask(fileId, type, args);
      }

      return Response.json({ success: true },  { status: 200 });
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
