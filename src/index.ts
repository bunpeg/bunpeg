import { $, serve, sql } from 'bun';
import fs from 'fs';
import { rm } from "node:fs/promises";
import { nanoid } from 'nanoid';

import docs from './www/docs.html';
import upload from './www/upload.html';

import { bulkCreateTasks, createTask, deleteAllTasksForFile, getTasksForFile, type Task } from './utils/tasks.ts';
import { createFile, deleteFile, getFile } from './utils/files.ts';
import { ChainSchema, CutEndSchema, ExtractAudioSchema, TranscodeSchema, TrimSchema } from './schemas.ts';
import { startFFQueue } from './utils/queue-ff.ts';
import { after, startBgQueue } from './utils/queue-bg.ts';

const inputDir = "./data/bucket";

fs.mkdirSync(inputDir, { recursive: true });

void startFFQueue();
void startBgQueue();

const server = serve({
  routes: {
    "/": docs,
    "/form": upload,
    "/ffmpeg/version": async () => {
      const output = await $`ffmpeg -version`.text();
      const parts = output.split("\n");
      return new Response(parts[0]);
    },

    "/wipe": async () => {
      let count = 0;
      await sql`DELETE FROM files`;
      await sql`'DELETE FROM tasks`;
      await rm(inputDir, { recursive: true, force: true });

      return new Response(`Platform wiped!`);
    },

    "/upload": async (req) => {
      const formData = await req.formData();
      const __file = formData.get('file');
      if (!__file) throw new Error('Must upload a file.');

      const fileId = nanoid(8);
      const file = __file as unknown as File;
      const parts = file.name.split('.');
      const extension = parts.pop();
      const extendedName = `${parts.join('.')}-${fileId}.${extension}`;

      await createFile(fileId, file.name, `${inputDir}/${extendedName}`);
      await Bun.write(`${inputDir}/${extendedName}`, file);

      return Response.json({ fileId }, { status: 200 });
    },

    "/download/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const dbFile = await getFile(fileId);
      console.log('dbFile', dbFile);
      if (!dbFile?.file_name) throw new Error('Invalid file id');

      const file = Bun.file(dbFile.file_path);

      after(async () => {
        await file.delete();
        await deleteAllTasksForFile(fileId);
        await deleteFile(fileId);
      });

      return new Response(file, {
        headers: {
          'content-disposition': `attachment; filename="${dbFile.file_name}"`,
        },
      });
    },

    "/output/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const dbFile = await getFile(fileId);
      if (!dbFile?.file_name) throw new Error('Invalid file id');

      const file = Bun.file(dbFile.file_path);

      return new Response(file, {
        headers: {
          'content-disposition': `attachment; filename="${dbFile.file_name}"`,
        },
      });
    },

    "/status/:fileId": async (req) => {
      const fileId = req.params.fileId;
      const tasks = await getTasksForFile(fileId);

      if (tasks.length === 0) {
        return Response.json({ fileId, status: 'not-found' }, { status: 200 });
      }

      // TODO: double check this logic
      const pendingStatus = ['queued', 'processing'] as Task['status'][];
      const isPending = tasks.some((task) => pendingStatus.includes(task.status));
      const lastTask = tasks.at(-1)!;

      return Response.json({ fileId, status: isPending ? 'pending' : lastTask.status },  { status: 200 });
    },

    "/transcode":  async (req) => {
      const parsed = TranscodeSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, format } = parsed.data;
      const file = await getFile(fileId);

      if (!file || !fs.existsSync(file.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      await createTask(fileId, 'transcode', { format });
      return Response.json({ success: true }, { status: 200 });
    },

    "/trim": async (req) => {
      const parsed = TrimSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, start, duration, outputFormat } = parsed.data;

      const userFile = await getFile(fileId);
      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      await createTask(fileId, 'trim', { start, duration, outputFormat });
      return Response.json({ success: true }, { status: 200 });
    },

    "/cut-end": async (req) => {
      const parsed = CutEndSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, duration, outputFormat } = parsed.data;

      const userFile = await getFile(fileId);

      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response('File not found', { status: 400 });
      }

      await createTask(fileId, 'cut-end', { duration, outputFormat });
      return Response.json({ success: true }, { status: 200 });
    },

    "/extract-audio": async (req) => {
      const parsed = ExtractAudioSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, audioFormat } = parsed.data;
      const userFile = await getFile(fileId);

      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      await createTask(fileId, 'extract-audio', { audioFormat });
      return Response.json({ success: true },  { status: 200 });
    },

    "/chain": async (req) => {
      const parsed = ChainSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, operations } = parsed.data;
      const userFile = await getFile(fileId);
      if (!userFile || !fs.existsSync(userFile.file_path)) {
        return new Response("File not found", { status: 404 });
      }

      await bulkCreateTasks(operations.map(({ type: operation, ...args }) => ({
        fileId,
        operation,
        args,
      })))

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
  development: !!process.env.RAILWAY_PROJECT_ID,
});

console.log(`Server started on ${server.url}`);
