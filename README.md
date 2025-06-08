# bunpeg

Bunpeg is a service for performing FFmpeg operations via simple HTTP API endpoints. You can upload media files (video or audio), run FFmpeg commands on them, and download the results. This service is built with [Bun](https://bun.sh).

I ended up building it because I needed a way to run FFmpeg serverless and I coun't make it work with Next.js or React, all of this for another side project :) .

PS: This is the first time I work with FFmpeg, so commands need a lot of tweaking.

## How to test
You can use this [link](https://bunpeg.io) to see it in action, it's a simple Next.js app that can perform the commands.

## Features
- Upload video or audio files
- Trim, transcode, or extract audio from media
- Chain multiple FFmpeg operations in a single request
- Download original or processed files
- Check the status of processing tasks

## Installation

```bash
bun install
```

## Running the Service

```bash
bun run src/index.ts
```

## API Endpoints (Minimal Docs)

### POST /upload
Upload a media file (video or audio).
- **Request:** `multipart/form-data` with a `file` field
- **Response:** `{ "fileId": "string" }`

### POST /trim
Trim a video.
- **Request:** `application/json` with `{ "fileId": string, "start": string, "duration": string }`
- **Response:** `{ "taskId": "string" }`

### POST /cut-end
Remove seconds from the end of a media file.
- **Request:** `application/json` with `{ "fileId": string, "duration": string }`
- **Response:** `{ "taskId": "string" }`

### POST /extract-audio
Extract audio from a video.
- **Request:** `application/json` with `{ "fileId": string }`
- **Response:** `{ "taskId": "string" }`

### POST /transcode
Transcode a video to a different format.
- **Request:** `application/json` with `{ "fileId": string, "format": string }`
- **Response:** `{ "taskId": "string" }`

### POST /chain
Chain multiple FFmpeg operations together.
- **Request:** `application/json` with `{ "fileId": string, "operations": [ ... ] }`
- **Response:** `{ "taskId": "string" }`

### GET /status/{taskId}
Get the status of a processing task.
- **Response:** `{ "status": "pending|complete|error", "error": string | null }`

### GET /download/{fileId}
Download the original uploaded file.

### GET /output/{fileId}
Download the processed output file.

---

For a full OpenAPI spec and interactive docs, visit the `/` route in your browser after starting the service.
