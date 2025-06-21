# Bunpeg

Bunpeg is a service for performing FFmpeg operations via HTTP. You can upload media files (video or audio),
run FFmpeg commands on them, and download the results. This service is built with [Bun](https://bun.sh).
I ended up building it because I needed a way to run FFmpeg serverless and I couldn't make it work with Next.js or React,
all of this for another side project :) .

PS: This is the first time I work with FFmpeg, so commands need a lot of tweaking.

## Installation

```bash
bun install
```

## Running the Service

```bash
bun run src/index.ts
```


## Features
- Upload video or audio files
- Trim, transcode, or extract audio from media
- Chain multiple FFmpeg operations in a single request
- Download original or processed files
- Check the status of processing tasks

You can use the [playground](https://bunpeg.io/playground) to see it in action.

## File Operations

### Upload a File

Upload a media file (video or audio) to the server.

```http
POST /upload
Content-Type: multipart/form-data

file: <binary>
```

**Response**
```json
{
  "fileId": "string"
}
```

**Notes:**
- Maximum file size: 500MB
- Supported formats: Video and audio files
- Files are stored in S3 and processed asynchronously

### Get File Metadata

Retrieve metadata for a specific file.

```http
GET /meta/{fileId}
```

**Response**
For video files
```json
{
  "size": "number",
  "duration": "number",
  "bit_rate": "number",
  "resolution": {
    "width": "number",
    "height": "number"
  }
}
```
For audio files
```json
{
  "size": "number",
  "duration": "number",
  "bit_rate": "number",
  "sample_rate": "number",
  "channels": "number"
}
```
For image files
```json
{
  "size": "number",
  "color_range": "string",
  "color_space": "string",
  "resolution": {
    "width": "number",
    "height": "number"
  }
}
```

### Get Processing Status

Check the processing status of a file.

```http
GET /status/{fileId}
```

**Response**
```json
{
  "fileId": "string",
  "status": "not-found | pending | completed | failed"
}
```

### Get Output File

Retrieve the processed output file.

```http
GET /output/{fileId}
```

**Response**
- Binary file content

### Download and Delete

Download a file and automatically delete it afterward.

```http
GET /download/{fileId}
```

**Response**
- Binary file content

### Delete File

Delete a file and its associated tasks.

```http
DELETE /delete/{fileId}
```

**Response**
```json
{
  "fileId": "string"
}
```

## Media Processing Operations

### Transcode Video

Convert a video to a different format.

```http
POST /transcode
Content-Type: application/json

{
  "fileId": "string",
  "format": "mp4 | mkv | webm | mov | avi"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Uses FFmpeg's copy codec for faster transcoding
- Preserves original video and audio quality
- Operation timeout: 15 minutes

### Resize Video

Resize a video to different dimensions.

```http
POST /resize-video
Content-Type: application/json

{
  "fileId": "string",
  "width": number,
  "height": number,
  "outputFormat": "mp4 | mkv | webm | mov | avi"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Uses FFmpeg's scale filter
- Maintains aspect ratio
- Output is encoded with libx264 codec

### Trim Video

Trim a segment from a video.

```http
POST /trim
Content-Type: application/json

{
  "fileId": "string",
  "start": "number",
  "duration": "number",
  "outputFormat": "mp4 | mkv | webm | mov | avi"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Uses FFmpeg's copy codec for fast trimming
- Precise frame-accurate trimming
- Preserves original quality

### Trim End

Cut a segment from the end of a video.

```http
POST /trim-end
Content-Type: application/json

{
  "fileId": "string",
  "duration": "number",
  "outputFormat": "mp4 | mkv | webm | mov | avi"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Automatically calculates total duration
- Uses FFmpeg's copy codec
- Throws error if resulting video would be empty

### Extract Audio

Extract audio from a video file.

```http
POST /extract-audio
Content-Type: application/json

{
  "fileId": "string",
  "audioFormat": "mp3 | m4a | aac | flac | wav | opus"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Codec selection based on format:
  - MP3: libmp3lame with quality 2
  - AAC/M4A: AAC codec at 192kbps
  - WAV: PCM 16-bit
  - FLAC: Native FLAC codec
  - Opus: libopus at 128kbps

### Remove Audio

Remove the audio track from a video.

```http
POST /remove-audio
Content-Type: application/json

{
  "fileId": "string",
  "outputFormat": "mp4 | mkv | webm | mov | avi"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Uses FFmpeg's `-an` flag to strip audio
- Preserves video quality
- Fast operation as it only removes audio stream

### Add Audio

Add an audio track to a video.

```http
POST /add-audio
Content-Type: application/json

{
  "videoFileId": "string",
  "audioFileId": "string",
  "outputFormat": "mp4 | mkv | webm | mov | avi"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Smart codec selection based on output format:
  - MP4/MOV: AAC (192kbps) or copy if compatible
  - WebM: Opus (128kbps) or copy if compatible
  - MKV: Supports multiple codecs, defaults to AAC
  - AVI: MP3 or WAV
- Uses `-shortest` flag to match video duration
- Preserves video quality with `-c:v copy`

### Merge Media

Merge multiple media files.

```http
POST /merge
Content-Type: application/json

{
  "fileIds": ["string", "string"],
  "outputFormat": "string"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Automatically detects and matches resolution
- Preserves aspect ratio with padding
- Uses complex filter chain for proper concatenation
- Output encoding:
  - Video: H.264 (libx264) with fast preset, CRF 22
  - Audio: AAC at 192kbps

### Extract Thumbnail

Extract a thumbnail from a video.

```http
POST /extract-thumbnail
Content-Type: application/json

{
  "fileId": "string",
  "timestamp": "string",
  "imageFormat": "jpg | jpeg | png | webp | gif | avif | svg"
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Uses FFmpeg's `-vframes 1` for single frame extraction
- High quality setting with `-q:v 2`
- Supports multiple image formats
- Frame-accurate timestamp selection

### Chain Operations

Chain multiple operations on a file.

```http
POST /chain
Content-Type: application/json

{
  "fileId": "string",
  "operations": [
    {
      "type": "transcode" | "resize-video" | "trim" | "trim-end" | "extract-audio" | "merge-media" | "add-audio" | "remove-audio" | "extract-thumbnail",
      // Operation-specific parameters
    }
  ]
}
```

**Response**
```json
{
  "success": true
}
```

**Technical Details:**
- Operations are executed sequentially
- Each operation maintains its own quality settings
- Intermediate files are automatically cleaned up
- Progress can be monitored via status endpoint

## Error Handling

All endpoints return appropriate HTTP status codes:

- 200: Success
- 400: Bad Request (invalid parameters)
- 404: File Not Found
- 413: File Too Large
- 500: Internal Server Error

## Rate Limiting

Currently, there are no rate limits implemented.

## Best Practices

1. Always check the file status after initiating an operation
2. Use the chain operation for multiple transformations to reduce processing time
3. Delete files after use to free up storage
4. Monitor file sizes to stay within the 500MB limit
5. Choose appropriate output formats based on your needs:
  - MP4: Best for web playback and compatibility
  - WebM: Best for web with VP8/VP9 codec
  - MKV: Best for quality preservation
  - AVI: Legacy format, limited codec support
6. For audio operations:
  - Use AAC for best compatibility
  - Use Opus for best quality/size ratio
  - Use FLAC for lossless quality
7. For video operations:
  - Use copy codec when possible for faster processing
  - Consider resolution and bitrate for optimal quality
  - Use appropriate container format for your target platform


---

For a full OpenAPI spec and interactive docs, visit the `/` route in your browser after starting the service.
