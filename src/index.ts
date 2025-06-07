import { $, serve, sql } from 'bun';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import Busboy from 'busboy';

import docs from './www/docs.html';
import upload from './www/upload.html';

import { bulkCreateTasks, createTask, deleteAllTasksForFile, getTasksForFile, type Task } from './utils/tasks.ts';
import { createFile, deleteFile, getFile, updateFile } from './utils/files.ts';
import { ChainSchema, CutEndSchema, ExtractAudioSchema, TranscodeSchema, TrimSchema } from './schemas.ts';
import { startFFQueue } from './utils/queue-ff.ts';
import { after, startBgQueue } from './utils/queue-bg.ts';
import { spaces } from './utils/s3.ts';
import { getAudioMetadata, getVideoMetadata } from './utils/ffmpeg.ts';

const MAX_FILE_SIZE_UPLOAD = Number(process.env.MAX_FILE_SIZE_UPLOAD);

const tempDir = "./data/temp";
fs.mkdirSync(tempDir, { recursive: true });

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

    "/files": async () => {
      const files = await sql`SELECT * FROM files`;
      return Response.json({ files }, { status: 200 });
    },

    "/tasks/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const tasks = await getTasksForFile(fileId);
      return Response.json({ tasks }, { status: 200 });
    },

    "/upload": {
      OPTIONS: async () => {
        return new Response('OK', {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      },
      POST: async (req) => {
        const contentType = req.headers.get("content-type") || "";
        if (!contentType.includes("multipart/form-data")) {
          return new Response("Invalid content type", { status: 400 });
        }

        let fileUploaded = true;
        let fileTooLarge = false;
        let isVideo = false;
        let isAudio = false;
        let fileId: string | undefined;
        let fileKey: string | undefined;
        const bb = Busboy({ headers: Object.fromEntries(req.headers), limits: { files: 1 } });

        bb.on("file", async (_f, fileStream, info) => {
          const { filename, mimeType } = info;

          if (!mimeType.startsWith("video/") && !mimeType.startsWith("audio/")) {
            fileStream.resume(); // Drain stream
            bb.emit("error", new Error("Invalid file type. Only video/audio allowed."));
            return;
          }

          if (mimeType.startsWith("video/")) isVideo = true;
          if (mimeType.startsWith("audio/")) isAudio = true;

          const ext = path.extname(filename) || ".unknown";
          fileId = nanoid(8);
          fileKey = `${fileId}${ext}`;
          const s3File = spaces.file(fileKey);

          // Stream to localFile
          const writer = s3File.writer({
            partSize: 5 * 1024 * 1024,
            queueSize: 10,
            retry: 3,
          });

          const executeWrite = async () => {
            let uploadedSize = 0;
            for await (const chunk of fileStream) {
              uploadedSize += chunk.length;

              if (uploadedSize > MAX_FILE_SIZE_UPLOAD) {
                fileTooLarge = true;
                break;
              }

              writer.write(chunk);
            }
            await writer.end();
          }

          await executeWrite();
          if (fileTooLarge) {
            await s3File.delete();
          } else {
            await createFile(fileId, filename, fileKey, mimeType);
            // Update file metadata after upload, this is to avoid blocking the request any further
            after(async () => {
              if (!fileId || !fileKey) return;

              if (isVideo) {
                const meta = await getVideoMetadata(fileKey);
                await updateFile(fileId, { metadata: JSON.stringify(meta) });
              }

              if (isAudio) {
                const meta = await getAudioMetadata(fileKey);
                await updateFile(fileId, { metadata: JSON.stringify(meta) });
              }
            });
          }
        });

        bb.on("error", (err) => {
          console.error("Upload error:", err);
          fileUploaded = false;
        });

        const body = req.body as AsyncIterable<Uint8Array>;
        for await (const chunk of body) {
          bb.write(chunk);
        }
        bb.end();

        if (fileTooLarge) {
          return new Response("File size exceeded limits", {
            status: 413,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });
        }

        if (!fileUploaded) {
          return new Response("Failed to upload the file", {
            status: 400,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });
        }

        return Response.json({ fileId }, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
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

    "/output/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const dbFile = await getFile(fileId);
      if (!dbFile) throw new Error('Invalid file id');

      const file = spaces.file(dbFile.file_path, { acl: 'public-read' });
      return new Response(file);
    },

    "/download/:fileId": async (req) => {
      const fileId = req.params.fileId;
      if (!fileId) throw new Error('Invalid file id');

      const dbFile = await getFile(fileId);
      console.log('dbFile', dbFile);
      if (!dbFile) throw new Error('Invalid file id');

      const file = spaces.file(dbFile.file_path, { acl: 'public-read' });

      after(async () => {
        await file.delete();
        await deleteAllTasksForFile(fileId);
        await deleteFile(fileId);
      });

      return new Response(file);
    },

    "/delete/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      },
      DELETE: async (req) => {
        const fileId = req.params.fileId;
        if (!fileId) throw new Error('Invalid file id');

        const dbFile = await getFile(fileId);
        if (!dbFile) throw new Error('Invalid file id');

        const file = spaces.file(dbFile.file_path, { acl: 'public-read' });
        if (await file.exists()) {
          await file.delete();
        }

        await deleteAllTasksForFile(fileId);
        await deleteFile(fileId);

        return Response.json({ fileId }, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }
    },

    "/transcode":  async (req) => {
      const parsed = TranscodeSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, format } = parsed.data;
      const file = await getFile(fileId);

      if (!file || !(await spaces.file(file.file_path).exists())) {
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
      if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
        return new Response("File not found", { status: 404 });
      }

      await createTask(fileId, 'trim', { start, duration, outputFormat });
      return Response.json({ success: true }, { status: 200 });
    },

    "/trim-end": async (req) => {
      const parsed = CutEndSchema.safeParse(await req.json());

      if (!parsed.success) {
        return Response.json(parsed.error, { status: 400 });
      }

      const { fileId, duration, outputFormat } = parsed.data;

      const userFile = await getFile(fileId);

      if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
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

      if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
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
      if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
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
  maxRequestBodySize: MAX_FILE_SIZE_UPLOAD,
  development: !!process.env.RAILWAY_PROJECT_ID,
});

console.log(`Server started on ${server.url}`);
