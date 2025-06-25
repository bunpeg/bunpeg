import { $, serve, sql } from 'bun';
import path from 'path';
import { nanoid } from 'nanoid';
import Busboy from 'busboy';

import docs from './www/docs.html';
import upload from './www/upload.html';

import {
  bulkCreateTasks,
  createTask,
  deleteAllTasksForFile,
  getTasksForFile,
  restoreAllProcessingTasksToQueued,
  type Task,
} from './utils/tasks.ts';
import { checkFilesExist, createFile, deleteFile, getFile } from './utils/files.ts';
import {
  AddAudioTrackSchema,
  ChainSchema,
  CutEndSchema,
  ExtractAudioSchema,
  ExtractThumbnailSchema,
  MergeMediaSchema,
  RemoveAudioSchema,
  ResizeVideoSchema,
  TranscodeSchema,
  TrimSchema,
} from './utils/schemas.ts';
import { startFFQueue } from './utils/queue-ff.ts';
import { after, startBgQueue } from './utils/queue-bg.ts';
import { spaces } from './utils/s3.ts';
import { getFileMetadata, updateFileMetadata } from './utils/ffmpeg.ts';
import { ALLOWED_MIME_TYPES } from './utils/formats.ts';
import { tryCatch } from './utils/promises.ts';
import { initDir, META_DIR, TEMP_DIR } from './utils/dirs.ts';

const MAX_FILE_SIZE_UPLOAD = Number(process.env.MAX_FILE_SIZE_UPLOAD);

await initDir(TEMP_DIR);
await initDir(META_DIR);
await restoreAllProcessingTasksToQueued();

startFFQueue();
startBgQueue();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const server = serve({
  routes: {
    "/": docs,

    "/openapi.yaml": async () => {
      const file = Bun.file(path.join(import.meta.dir, "www/openapi.yaml"));
      return new Response(file, {
        headers: {
          "Content-Type": "application/yaml"
        }
      });
    },

    "/form": process.env.NODE_ENV === 'dev'
      ? upload
      : Response.redirect("/"),

    "/ffmpeg/version": async () => {
      const output = await $`ffmpeg -version`.text();
      const parts = output.split("\n");
      return new Response(parts[0]);
    },

    "/files": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async () => {
        const files = await sql`SELECT * FROM files ORDER BY created_at`;
        return Response.json({ files }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/files/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.fileId;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const [file] = await sql`SELECT * FROM files WHERE id = ${fileId}`;

        if (!file) {
          return Response.json({ file: null }, { status: 400, headers: CORS_HEADERS });
        }

        return Response.json({
          file: { ...file, metadata: JSON.parse(file.metadata) },
        }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/tasks": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async () => {
        const tasks = await sql`SELECT * FROM tasks ORDER BY id`;
        return Response.json({ tasks }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/upload": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const contentType = req.headers.get("content-type") || "";
        if (!contentType.includes("multipart/form-data")) {
          return new Response("Invalid content type", { status: 400, headers: CORS_HEADERS });
        }

        let fileUploaded = true;
        let fileTooLarge = false;
        let fileId: string | undefined;
        let fileKey: string | undefined;
        const bb = Busboy({ headers: Object.fromEntries(req.headers), limits: { files: 1 } });

        const upload = new Promise<boolean>(async (resolve) => {
          bb.on("file", async (_f, fileStream, info) => {
            const { filename, mimeType } = info;

            if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
              fileStream.resume(); // Drain stream
              bb.emit("error", new Error("Invalid file type. Only video/audio allowed."));
              return;
            }

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
              resolve(false);
            } else {
              await createFile({ id: fileId, file_name: filename, file_path: fileKey, mime_type: mimeType });
              fileUploaded = true;
              resolve(true);
            }
          });

          bb.on("error", (err) => {
            console.error("Upload error:", err);
            fileUploaded = false;
            resolve(false);
          });

          const body = req.body as AsyncIterable<Uint8Array>;
          for await (const chunk of body) {
            bb.write(chunk);
          }
          bb.end();
        });

        await upload;

        if (fileTooLarge) {
          return new Response("File size exceeded limits", { status: 413, headers: CORS_HEADERS });
        }

        if (!fileUploaded) {
          return new Response("Failed to upload the file", { status: 400, headers: CORS_HEADERS });
        }

        after(async () => {
          if (!fileId) return;
          await updateFileMetadata(fileId);
        })

        return Response.json({ fileId }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/meta/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.fileId;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const { data: meta, error } = await tryCatch(getFileMetadata(fileId));
        if (error) {
          return new Response("Could not resolve metadata information", { status: 401, headers: CORS_HEADERS });
        }

        return Response.json(meta, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/status/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET:  async (req) => {
        const fileId = req.params.fileId;
        const tasks = await getTasksForFile(fileId);

        if (tasks.length === 0) {
          return Response.json({ fileId, status: 'not-found' }, { status: 200, headers: CORS_HEADERS });
        }

        // TODO: double check this logic
        const pendingStatus = ['queued', 'processing'] as Task['status'][];
        const isPending = tasks.some((task) => pendingStatus.includes(task.status));
        const lastTask = tasks.at(-1)!;

        return Response.json({ fileId, status: isPending ? 'pending' : lastTask.status },  { status: 200, headers: CORS_HEADERS });
      },
    },

    "/output/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.fileId;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response('Invalid file id', { status: 400, headers: CORS_HEADERS });

        const file = spaces.file(dbFile.file_path, { acl: 'public-read' });
        return new Response(file);
      }
    },

    "/download/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.fileId;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        console.log('dbFile', dbFile);
        if (!dbFile) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const file = spaces.file(dbFile.file_path, { acl: 'public-read' });

        after(async () => {
          await file.delete();
          await deleteAllTasksForFile(fileId);
          await deleteFile(fileId);
        });

        return new Response(file, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/delete/:fileId": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      DELETE: async (req) => {
        const fileId = req.params.fileId;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const file = spaces.file(dbFile.file_path, { acl: 'public-read' });
        if (await file.exists()) {
          await file.delete();
        }

        await deleteAllTasksForFile(fileId);
        await deleteFile(fileId);

        return Response.json({ fileId }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/transcode":  {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = TranscodeSchema.safeParse(await req.json());

        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { fileId, format } = parsed.data;
        const file = await getFile(fileId);

        if (!file || !(await spaces.file(file.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(fileId, 'transcode', { fileId, format });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/resize-video": {
      OPTIONS: async () => new Response('OK', { headers: CORS_HEADERS }),
      POST: async (req) => {
        const parsed = ResizeVideoSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }
        const { fileId, width, height, outputFormat } = parsed.data;
        if (!(await checkFilesExist([fileId]))) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }
        await createTask(fileId, 'resize-video', { fileId, width, height, outputFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/trim": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = TrimSchema.safeParse(await req.json());

        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { fileId, start, duration, outputFormat } = parsed.data;

        const userFile = await getFile(fileId);
        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(fileId, 'trim', { fileId, start, duration, outputFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/trim-end": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = CutEndSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { fileId, duration, outputFormat } = parsed.data;

        const userFile = await getFile(fileId);

        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response('File not found', { status: 400, headers: CORS_HEADERS });
        }

        await createTask(fileId, 'trim-end', { fileId, duration, outputFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/extract-audio": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = ExtractAudioSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { fileId, audioFormat } = parsed.data;
        const userFile = await getFile(fileId);

        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(fileId, 'extract-audio', { fileId, audioFormat });
        return Response.json({ success: true },  { status: 200, headers: CORS_HEADERS });
      }
    },

    "/remove-audio": {
      OPTIONS: async () => new Response('OK', { headers: CORS_HEADERS }),
      POST: async (req) => {
        const parsed = RemoveAudioSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }
        const { fileId, outputFormat } = parsed.data;
        if (!(await checkFilesExist([fileId]))) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(fileId, 'remove-audio', { fileId, outputFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/add-audio": {
      OPTIONS: async () => new Response('OK', { headers: CORS_HEADERS }),
      POST: async (req) => {
        const parsed = AddAudioTrackSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }
        const { videoFileId, audioFileId, outputFormat } = parsed.data;
        // Check both files exist in one query
        if (!(await checkFilesExist([videoFileId, audioFileId]))) {
          return new Response("Video or audio file not found", { status: 404, headers: CORS_HEADERS });
        }
        await createTask(videoFileId, 'add-audio', { videoFileId, audioFileId, outputFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/merge": {
      OPTIONS: async () => new Response('OK', { headers: CORS_HEADERS }),
      POST: async (req) => {
        const parsed = MergeMediaSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }
        const { fileIds, outputFormat } = parsed.data;
        // Check all files exist in one query
        if (!(await checkFilesExist(fileIds))) {
          return new Response(`One or more files not found`, { status: 404, headers: CORS_HEADERS });
        }
        await createTask(fileIds[0]!, 'merge-media', { fileIds, outputFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/extract-thumbnail": {
      OPTIONS: async () => new Response('OK', { headers: CORS_HEADERS }),
      POST: async (req) => {
        const parsed = ExtractThumbnailSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }
        const { fileId, timestamp, imageFormat } = parsed.data;
        if (!(await checkFilesExist([fileId]))) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }
        await createTask(fileId, 'extract-thumbnail', { fileId, timestamp, imageFormat });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/chain": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = ChainSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { fileId, operations } = parsed.data;
        const userFile = await getFile(fileId);
        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await bulkCreateTasks(operations.map(({ type: operation, ...args }) => ({
          fileId,
          operation,
          args: { ...args, fileId },
        })))

        return Response.json({ success: true },  { status: 200, headers: CORS_HEADERS });
      }
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
