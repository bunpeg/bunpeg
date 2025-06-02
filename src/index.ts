import { serve, $ } from "bun";
import fs from "fs";
import { nanoid } from 'nanoid';
import { z } from 'zod';

import docs from "./www/docs.html";
import upload from "./www/upload.html";

import { connectDb, initDb } from './utils/db';
import { extractAudio, trim } from './utils/ffmpeg.ts';
import { createTask, getTask } from './utils/tasks.ts';
import { createFile, getFile } from './utils/files.ts';

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

    "/upload": async (req) => {
      const formData = await req.formData();
      const __file = formData.get('file');
      if (!__file) throw new Error('Must upload a profile picture.');

      const fileId = nanoid(8);
      const file = __file as unknown as File;
      const parts = file.name.split('.');
      const extension = parts.pop();
      const extendedName = `${parts.join('.')}-${fileId}.${extension}`;

      createFile(fileId, file.name, `${uploadDir}/${extendedName}`);
      await Bun.write(`${uploadDir}/${extendedName}`, file);

      return Response.json({ fileId }, { status: 200 });
    },

    "/download/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const dbFile = getFile(fileId);
      if (!dbFile?.file_name) throw new Error('Invalid file id');

      const file = Bun.file(dbFile.upload_path);

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

    "/output/:taskId": async (req) => {
      const taskId = req.params.taskId;

      const task = getTask(taskId);

      if (!task) {
        return new Response(`no task matching taskId: ${taskId}`, { status: 400 });
      }

      const userFile = getFile(task.file_id);

      if (!userFile?.output_path) {
        return new Response(`no output yet for task: ${taskId}`, { status: 400 });
      }

      const file = Bun.file(userFile.output_path);

      return new Response(file, {
        headers: {
          'content-disposition': `attachment; filename="${userFile.file_name}"`,
        },
      });
    },

    "/trim": async (req) => {
      const body = await req.json();

      const schema = z.object({
        fileId: z.string(),
        start: z.string(),
        duration: z.string(),
        outputFormat: z.string(),
      });

      const parsed = schema.safeParse(body);

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, start, duration, outputFormat } = parsed.data;

      const userFile = getFile(fileId);
      if (!userFile || !fs.existsSync(userFile.upload_path)) {
        return new Response("File not found", { status: 404 });
      }

      const taskId = nanoid(8);
      createTask(taskId, fileId);
      trim(userFile.upload_path, start, duration, outputFormat, taskId);

      return Response.json({ taskId }, { status: 200 });
    },

    "/extract-audio": async (req) => {
      const body = await req.json();

      const schema = z.object({
        fileId: z.string(),
        audioFormat: z.string(),
      })

      const parsed = schema.safeParse(body);

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, audioFormat } = parsed.data;
      const userFile = getFile(fileId);

      if (!userFile || !fs.existsSync(userFile.upload_path)) {
        return new Response("File not found", { status: 404 });
      }

      const taskId = nanoid(8);
      createTask(taskId, fileId);
      extractAudio(userFile.upload_path, audioFormat, taskId);

      return Response.json({ taskId }, { status: 200 });
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
