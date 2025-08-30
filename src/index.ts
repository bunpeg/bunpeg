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
  getTasksForFileAndDecendants,
  restoreAllProcessingTasksToQueued,
  type Task,
} from './utils/tasks.ts';
import { checkFilesExist, createFile, deleteFile, getDecendants, getFile } from './utils/files.ts';
import {
  AddAudioTrackSchema,
  BulkSchema,
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
import { spaces, deleteDashFiles } from './utils/s3.ts';
import { getFileMetadata, probeFileContent, updateFileMetadata } from './utils/ffmpeg.ts';
import { tryCatch } from './utils/promises.ts';
import { initDir, META_DIR, TEMP_DIR } from './utils/dirs.ts';
import { ALLOWED_MIME_TYPES } from './utils/formats.ts';

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

    "/files": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const url = new URL(req.url);
        const searchParams = url.searchParams;
        const parent = searchParams.get('parent');
        const parentFilter = parent ? sql`WHERE parent = ${parent}` : sql``;
        const files = await sql`SELECT * FROM files ${parentFilter} ORDER BY created_at`;
        return Response.json({ files }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/files/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req: Bun.BunRequest<"/files/:file_id">) => {
        const fileId = req.params.file_id;
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

    "/url/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req: Bun.BunRequest<"/url/:file_id">) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response('Invalid file id', { status: 400, headers: CORS_HEADERS });

        const fileUrl = spaces.presign(dbFile.file_path, { acl: 'public-read' });
        return new Response(fileUrl, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/meta/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const { data: meta, error } = await tryCatch(getFileMetadata(fileId));
        if (error) {
          return new Response("Could not resolve metadata information", { status: 401, headers: CORS_HEADERS });
        }

        return Response.json(meta, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/probe/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const { data: probeData, error } = await tryCatch(probeFileContent(fileId));

        if (error) {
          return Response.json(
            { error: "Could not probe file", details: error.message },
            { status: 500, headers: CORS_HEADERS }
          );
        }

        return Response.json(probeData, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/status/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const tasks = await getTasksForFileAndDecendants(fileId);

        if (tasks.length === 0) {
          return Response.json({ fileId, status: 'empty' }, { status: 200, headers: CORS_HEADERS });
        }

        const pendingStatus = ['queued', 'processing'] as Task['status'][];
        const isPending = tasks.some((task) => pendingStatus.includes(task.status));

        if (isPending) {
          return Response.json({ fileId, status: 'processing' }, { status: 200, headers: CORS_HEADERS });
        }

        const lastTask = tasks.at(-1)!;

        if (lastTask.status === 'completed') {
          return Response.json({ fileId, status: 'completed' }, { status: 200, headers: CORS_HEADERS });
        }

        const failedTasks = tasks.filter(t => t.status === 'failed');
        const lastFailedTask = failedTasks.at(-1)!;

        return Response.json({
          fileId,
          status: 'failed',
          error: lastFailedTask.error ?? null,
        }, { status: 200, headers: CORS_HEADERS });
      },
    },

    "/output/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response('Invalid file id', { status: 400, headers: CORS_HEADERS });

        const file = spaces.file(dbFile.file_path, { acl: 'public-read' });
        return new Response(file);
      }
    },

    "/download/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const file = spaces.file(dbFile.file_path, { acl: 'public-read' });

        after(async () => {
          await file.delete();
          await deleteAllTasksForFile(fileId);
          await deleteFile(fileId);
        });

        return new Response(file);
      }
    },

    "/delete/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      DELETE: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const file = spaces.file(dbFile.file_path);
        if (await file.exists()) await file.delete();

        const { error: dashError } = await tryCatch(deleteDashFiles(fileId));
        if (dashError) {
          console.error(`Failed to delete DASH files for ${fileId}:`, dashError);
        }

        const decendants = await getDecendants(fileId);
        const delPromises = decendants.map(async (decendant) => {
          const decendantFile = spaces.file(decendant.file_path);
          if (await decendantFile.exists()) await decendantFile.delete();
          await deleteDashFiles(decendant.id);
        });

        const delResults = await Promise.allSettled(delPromises);

        if (delResults.some((result) => result.status === 'rejected')) {
          console.error(`Failed to delete some decendants of file ${fileId}`, fileId);
        }

        await deleteAllTasksForFile(fileId);
        await deleteFile(fileId);

        return Response.json({ fileId }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/transcode": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = TranscodeSchema.safeParse(await req.json());

        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { file_id } = parsed.data;
        const file = await getFile(file_id);

        if (!file || !(await spaces.file(file.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'transcode', parsed.data);
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
        const { file_id } = parsed.data;

        const userFile = await getFile(file_id);
        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'resize-video', parsed.data);
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

        const { file_id } = parsed.data;

        const userFile = await getFile(file_id);
        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'trim', parsed.data);
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

        const { file_id } = parsed.data;
        const userFile = await getFile(file_id);

        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response('File not found', { status: 400, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'trim-end', parsed.data);
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

        const { file_id } = parsed.data;
        const userFile = await getFile(file_id);

        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'extract-audio', parsed.data);
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/remove-audio": {
      OPTIONS: async () => new Response('OK', { headers: CORS_HEADERS }),
      POST: async (req) => {
        const parsed = RemoveAudioSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }
        const { file_id } = parsed.data;
        if (!(await checkFilesExist([file_id]))) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'remove-audio', parsed.data);
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
        const { video_file_id, audio_file_id } = parsed.data;
        // Check both files exist in one query
        if (!(await checkFilesExist([video_file_id, audio_file_id]))) {
          return new Response("Video or audio file not found", { status: 404, headers: CORS_HEADERS });
        }
        await createTask(video_file_id, 'add-audio', parsed.data);
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
        const { file_ids } = parsed.data;
        // Check all files exist in one query
        if (!(await checkFilesExist(file_ids))) {
          return new Response(`One or more files not found`, { status: 404, headers: CORS_HEADERS });
        }
        await createTask(file_ids[0]!, 'merge-media', parsed.data);
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

        const { file_id } = parsed.data;
        const userFile = await getFile(file_id);

        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await createTask(file_id, 'extract-thumbnail', parsed.data);
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

        const { file_id, operations } = parsed.data;
        const userFile = await getFile(file_id);
        if (!userFile || !(await spaces.file(userFile.file_path).exists())) {
          return new Response("File not found", { status: 404, headers: CORS_HEADERS });
        }

        await bulkCreateTasks(operations.map(({ type: operation, ...args }) => ({
          file_id,
          operation,
          args: { file_id, ...args },
        })))

        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/bulk": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      POST: async (req) => {
        const parsed = BulkSchema.safeParse(await req.json());
        if (!parsed.success) {
          return Response.json(parsed.error, { status: 400, headers: CORS_HEADERS });
        }

        const { operation, file_ids } = parsed.data;
        const { type, ...args } = operation;

        if (!(await checkFilesExist(file_ids))) {
          return new Response(`One or more files not found`, { status: 404, headers: CORS_HEADERS });
        }

        await bulkCreateTasks(file_ids.map((file_id) => ({
          file_id,
          operation: type,
          args: { file_id: file_id, ...args },
        })))

        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS });
      }
    },

    "/dash/:file_id": {
      OPTIONS: async () => {
        return new Response('OK', { headers: CORS_HEADERS });
      },
      GET: async (req) => {
        const fileId = req.params.file_id;
        if (!fileId) return new Response("Invalid file id", { status: 400, headers: CORS_HEADERS });

        const dbFile = await getFile(fileId);
        if (!dbFile) return new Response('Invalid file id', { status: 400, headers: CORS_HEADERS });

        await createTask(fileId, 'dash', { file_id: fileId });
        return Response.json({ success: true }, { status: 200, headers: CORS_HEADERS })
      },
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
  idleTimeout: 240,
});

console.log(`Server started on ${server.url}`);
