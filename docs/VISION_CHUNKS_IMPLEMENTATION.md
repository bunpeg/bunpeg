# Vision Chunks (Scene Detection) Implementation Guide

## Overview

This document provides detailed implementation instructions for adding Vision Chunks functionality to the bunpeg project. The Vision Chunks feature prepares video files for VLM (Vision Language Model) processing, OCR, and shot selection by detecting scene changes, transcoding for optimal decode performance, and creating scene-based segments.

## Feature Requirements

### Goal
Produce H.264 MP4 scene segments with fixed 720p height and fast decode settings suitable for VLM processing from video files.

### Processing Steps
1. **Resize Video**: Scale video to 720p height (auto width) for optimal processing
2. **Transcode for VLM**: Apply H.264 encoding with fast decode settings (veryfast preset, CRF 23, AAC audio)
3. **Analyze Scenes**: Detect scene changes using configurable threshold
4. **Create Segments**: Export scene segments with copy codec and manifest

### Output Format
- Multiple MP4 files (scene_000.mp4, scene_001.mp4, etc.)
- Package manifest JSON with metadata and scene URLs

## Architecture Design

### Task-Based Processing
The Vision Chunks feature uses the existing task queue system with a 4-step workflow:

**Processing Pipeline**: `resize-video` → `transcode` → `vision-analyze` → `vision-segment`

Internal Vision operations:
1. `resize-video` - Scale to 720p height (existing operation)
2. `transcode` - Apply VLM-optimized encoding settings (enhanced existing operation)
3. `vision-analyze` - Scene detection and segment planning
4. `vision-segment` - Scene segment creation and manifest generation

### API Security
- Only `/vision` endpoint is public-facing
- Internal operations (`vision-analyze`, `vision-segment`) are not accessible via `/chain` or `/bulk`
- Direct task creation at endpoint level

## Implementation Steps

### Step 1: Update Schemas (`src/utils/schemas.ts`)

#### Enhance ResizeVideo Schema
Update existing `ResizeVideoParams` to support FFmpeg auto-scaling:

```typescript
const ResizeVideoParams = z.object({
  width: z.number().int().min(-2, 'Width must be positive or -1/-2 for auto-scaling'),
  height: z.number().int().min(-2, 'Height must be positive or -1/-2 for auto-scaling'),
  output_format: videoFormat,
  parent: parentId,
  mode,
});
```

#### Enhance Transcode Schema
Add optional parameters to existing `TranscodeParams`:

```typescript
const TranscodeParams = z.object({
  format: videoFormat,
  video_codec: videoCodec.optional(),
  audio_codec: audioCodec.optional(),
  preset: z.string().optional(), // H.264 preset (e.g., "veryfast")
  crf: z.number().int().min(0).max(51).optional(), // Quality setting
  audio_bitrate: z.string().optional(), // Audio bitrate (e.g., "128k")
  parent: parentId,
  mode,
});
```

#### Add Vision Types and Schemas
```typescript
const VisionParams = z.object({
  scene_threshold: z.number().min(0).max(1).default(0.4),
  parent: parentId,
});
export const VisionSchema = VisionParams.extend({ file_id: fileId });
export type VisionType = z.infer<typeof VisionSchema>;

const VisionAnalyzeSchema = z.object({
  file_id: fileId,
  scene_threshold: z.number().min(0).max(1),
  parent: parentId,
});
export type VisionAnalyzeType = z.infer<typeof VisionAnalyzeSchema>;

const VisionSegmentSchema = z.object({
  file_id: fileId,
  parent: parentId,
});
export type VisionSegmentType = z.infer<typeof VisionSegmentSchema>;
```

#### Update Operation Types
```typescript
type Operations = {
  // ... existing operations
  "vision-analyze": VisionAnalyzeType;
  "vision-segment": VisionSegmentType;
};

type OperationName =
  // ... existing operation names
  | "vision-analyze"
  | "vision-segment";
```

### Step 2: Create Vision Utilities (`src/utils/vision.ts`)

```typescript
interface SceneEvent {
  pts_time: number;
  score: number;
}

interface VisionSegment {
  index: number;
  start: number;
  duration: number;
  url: string;
}

interface VisionManifest {
  packageId: string;
  preset: string;
  fileId: string;
  resolution: {
    width: number;
    height: number;
  };
  totalDuration: number;
  sceneThreshold: number;
  segments: VisionSegment[];
}

async function detectScenes(
  inputFile: string,
  threshold: number,
  task: Task
): Promise<SceneEvent[]> {
  const args = [
    "-i", inputFile,
    "-vf", `select='gt(scene,${threshold})',showinfo`,
    "-f", "null", "-"
  ];

  const result = await runFFmpeg(args, task);
  const scenes: SceneEvent[] = [];

  // Parse pts_time from showinfo logs
  const lines = result.stderr.split('\n');
  for (const line of lines) {
    const match = line.match(/pts_time:(\d+\.?\d*)/);
    const scoreMatch = line.match(/scene:(\d+\.?\d*)/);
    if (match && scoreMatch) {
      scenes.push({
        pts_time: parseFloat(match[1]),
        score: parseFloat(scoreMatch[1])
      });
    }
  }

  // Always include start (0) and end
  const duration = await getVideoDuration(inputFile);
  if (scenes.length === 0) {
    throw new Error('No scenes detected. Video may be too static or threshold too high.');
  }
  if (scenes.length > 200) {
    throw new Error('Too many scenes detected (>200). Consider increasing threshold.');
  }

  return [
    { pts_time: 0, score: 1.0 },
    ...scenes,
    { pts_time: duration, score: 0 }
  ].sort((a, b) => a.pts_time - b.pts_time);
}

function planVisionChunks(scenes: SceneEvent[]): Array<{start: number, end: number}> {
  const chunks: Array<{start: number, end: number}> = [];

  for (let i = 0; i < scenes.length - 1; i++) {
    chunks.push({
      start: scenes[i].pts_time,
      end: scenes[i + 1].pts_time
    });
  }

  return chunks;
}

async function getVideoDuration(inputFile: string): Promise<number> {
  // Implementation similar to getAudioDuration in asr.ts
}

function createVisionManifest(
  packageId: string,
  fileId: string,
  segments: VisionSegment[],
  resolution: {width: number, height: number},
  totalDuration: number,
  sceneThreshold: number
): VisionManifest {
  return {
    packageId,
    preset: "vision-chunks",
    fileId,
    resolution,
    totalDuration,
    sceneThreshold,
    segments
  };
}
```

### Step 3: Enhance FFmpeg Functions (`src/utils/ffmpeg.ts`)

#### Update Existing Transcode Function
```typescript
export function transcode(args: TranscodeType, task: Task) {
  validateMuxCombination(args.format, args.video_codec || null, args.audio_codec || null);

  const outputFile = args.mode === 'replace' ? `${task.code}.${args.format}` : `${nanoid(8)}.${args.format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasVideo = await checkFileHasVideoStream(inputFile);
      if (!hasVideo) throw new Error('File has no video track');

      const ffmpegArgs = [
        "-i", inputFile,
        ...(args.video_codec ? ["-c:v", args.video_codec] : []),
        ...(args.audio_codec ? ["-c:a", args.audio_codec] : []),
        ...(args.preset ? ["-preset", args.preset] : []),
        ...(args.crf ? ["-crf", args.crf.toString()] : []),
        ...(args.audio_bitrate ? ["-b:a", args.audio_bitrate] : []),
        outputPath,
      ];

      return runFFmpeg(ffmpegArgs, task);
    },
  });
}
```

#### Add Vision Processing Functions
```typescript
export function visionAnalyze(args: VisionAnalyzeType, task: Task) {
  const outputFile = `${task.code}_analysis.json`;

  return handleS3DownAndUpAppend({
    task,
    outputFile,
    s3UploadPath: `${args.file_id}/vision/analysis.json`,
    fileIds: [args.file_id],
    parentFile: args.parent,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasVideo = await checkFileHasVideoStream(inputFile);
      if (!hasVideo) throw new Error('File has no video track');

      const scenes = await detectScenes(inputFile, args.scene_threshold, task);
      const chunks = planVisionChunks(scenes);

      // Store analysis results
      const analysisData = {
        scenes,
        chunks,
        threshold: args.scene_threshold,
        totalScenes: scenes.length - 2 // Exclude start/end markers
      };

      await writeFile(outputPath, JSON.stringify(analysisData, null, 2));
    },
  });
}

export async function visionSegment(args: VisionSegmentType, task: Task) {
  const { data: file, error } = await tryCatch(getFile(args.file_id));
  if (error || !file) {
    throw new Error(`Could not find file ${task.file_id}`);
  }

  const localPath = path.join(TEMP_DIR, file.file_path);
  const { error: downloadError } = await tryCatch(downloadFromS3ToDisk(file.file_path, localPath));
  if (downloadError) {
    logTask(task.id, `Failed to download file ${file.file_path} from S3`);
    await cleanupFile(localPath);
    throw downloadError;
  }

  const analysisPath = path.join(TEMP_DIR, `${file.id}_analysis.json`);
  const { error: analysisDownloadError } = await tryCatch(downloadFromS3ToDisk(`${file.id}/vision/analysis.json`, analysisPath));
  if (analysisDownloadError) {
    logTask(task.id, `Failed to download analysis file ${file.id}/vision/analysis.json from S3`);
    await cleanupFiles([localPath, analysisPath]);
    throw analysisDownloadError;
  }

  const segmentsPath = path.join(TEMP_DIR, `${file.id}/vision`);
  await mkdir(segmentsPath, { recursive: true });
  const manifestPath = path.join(segmentsPath, 'manifest.json');

  // Load analysis results
  const analysisData = JSON.parse(await Bun.file(analysisPath).text());
  const chunks = analysisData.chunks;

  if (chunks.length > 200) {
    throw new Error('Too many scenes to segment (>200)');
  }

  // Create each scene segment
  const segmentFiles: string[] = [];
  const segments: VisionSegment[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const duration = chunk.end - chunk.start;

    if (duration <= 0) continue;

    const segmentFileName = `scene_${index.toString().padStart(3, '0')}.mp4`;
    const segmentPath = path.join(segmentsPath, segmentFileName);

    await runFFmpeg([
      "-i", localPath,
      "-ss", chunk.start.toString(),
      "-to", chunk.end.toString(),
      "-c", "copy", // Copy codec for speed
      segmentPath
    ], task);

    segmentFiles.push(segmentFileName);
    segments.push({
      index,
      start: chunk.start,
      duration,
      url: `https://bunpeg.fra1.cdn.digitaloceanspaces.com/${file.id}/vision/${segmentFileName}`
    });
  }

  // Get video metadata for manifest
  const resolution = await getVideoResolution(localPath);
  const totalDuration = await getVideoDuration(localPath);

  // Create package manifest
  const manifest = createVisionManifest(
    task.code,
    args.file_id,
    segments,
    resolution,
    totalDuration,
    analysisData.threshold
  );

  // Save manifest
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));

  const segmentedFiles = await readdir(segmentsPath, { withFileTypes: true });
  for (const seg of segmentedFiles) {
    if (seg.isDirectory()) continue;

    const segFilePath = path.join(seg.parentPath, seg.name);
    const { error: uploadError } = await tryCatch(uploadToS3FromDisk(segFilePath, `${file.id}/vision/${seg.name}`, { acl: 'public-read' }));
    if (uploadError) {
      await cleanupFile(localPath);
      await rm(segmentsPath, { force: true, recursive: true });
      throw new Error(`Failed to upload vision segments for task ${task.id}`);
    }
  }

  if (await Bun.file(segmentsPath).exists()) {
    await rm(segmentsPath, { force: true, recursive: true });
  }

  await cleanupFile(localPath);
}
```

### Step 4: Update Queue System (`src/utils/queue-ff.ts`)

Add vision operations to the queue system:

```typescript
// Add to processFFmpegTask function
case "vision-analyze":
  return visionAnalyze(operation, task);
case "vision-segment":
  return visionSegment(operation, task);
```

### Step 5: Add API Endpoint (`src/index.ts`)

```typescript
"/vision": {
  OPTIONS: async () => {
    return new Response('OK', { headers: CORS_HEADERS });
  },
  POST: async (req) => {
    const body = await req.json();
    const parsed = VisionSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    const args = parsed.data;

    const file = await getFile(args.file_id);
    if (!file) return new Response('Invalid file id', { status: 400, headers: CORS_HEADERS });

    await bulkCreateTasks([
      {
        operation: 'resize-video' as Task['operation'],
        file_id: args.file_id,
        args: {
          file_id: args.file_id,
          width: -2,
          height: 720,
          output_format: 'mp4' as VideoFormat,
          parent: args.parent,
          mode: 'append',
        }
      },
      {
        operation: 'transcode' as Task['operation'],
        file_id: args.file_id,
        args: {
          file_id: args.file_id,
          format: 'mp4',
          video_codec: 'h264',
          audio_codec: 'aac',
          preset: 'veryfast',
          crf: 23,
          audio_bitrate: '128k',
          parent: args.parent,
          mode: 'append',
        }
      },
      {
        operation: 'vision-analyze' as Task['operation'],
        file_id: args.file_id,
        args: {
          file_id: args.file_id,
          scene_threshold: args.scene_threshold,
          parent: args.parent,
        }
      },
      {
        operation: 'vision-segment' as Task['operation'],
        file_id: args.file_id,
        args: {
          file_id: args.file_id,
          parent: args.parent,
        }
      }
    ]);

    return Response.json({ success: true }, { headers: CORS_HEADERS });
  }
},
```

## Implementation Notes

### Leveraging Existing Functionality
- Enhances existing `resize-video` operation to support FFmpeg auto-scaling (-1, -2 values)
- Enhances existing `transcode` operation with optional VLM-specific parameters
- Reuses existing helpers like `checkFileHasVideoStream()` and `runFFmpeg()`
- Maximum separation of concerns and code reuse

### File ID Chaining
The implementation uses sequential task dependencies where each task references outputs from previous tasks. The `vision-segment` operation requires both the transcoded video and analysis results.

### Error Handling
- Scene detection failures (no scenes, too many scenes) fail the task with specific messages
- Files without video tracks are rejected at API level
- FFmpeg errors are handled gracefully with cleanup
- Temporary files are cleaned up even on errors

### Performance Considerations
- Two-step transcoding process optimizes for VLM decode performance
- Scene detection runs on already-transcoded 720p file for consistency
- Segment creation uses copy codec for speed (no re-encoding)
- Consider timeout values for long videos with many scenes

### Storage Management
- Intermediate files (720p resized, transcoded, analysis) are retained for debugging
- Scene segments multiply storage usage significantly
- Consider cleanup policies for intermediate files
- Manifest provides centralized metadata access

### Testing
1. Test with various video formats (MP4, MKV, AVI, MOV)
2. Test with different scene detection thresholds (0.1 to 0.8)
3. Test with different video lengths and scene complexities
4. Test static videos (should fail gracefully)
5. Test videos with many scene changes (should limit to 200)
6. Verify segment timing accuracy and playback
7. Test error scenarios (corrupted files, insufficient disk space)
8. Test videos with no video track (should fail at API level)
9. Test resolution scaling and encoding quality

## API Usage Example

```bash
curl -X POST http://localhost:3000/vision \
  -H "Content-Type: application/json" \
  -d '{
    "file_id": "abc123def456",
    "scene_threshold": 0.4,
    "parent": "parent_folder_id"
  }'
```

**Response:**
```json
{
  "tasks": [
    {
      "id": "task_001",
      "code": "resize_code",
      "operation": "resize-video",
      "status": "queued"
    },
    {
      "id": "task_002",
      "code": "transcode_code",
      "operation": "transcode",
      "status": "queued"
    },
    {
      "id": "task_003",
      "code": "analyze_code",
      "operation": "vision-analyze",
      "status": "queued"
    },
    {
      "id": "task_004",
      "code": "segment_code",
      "operation": "vision-segment",
      "status": "queued"
    }
  ],
  "package_id": "segment_code"
}
```

## Expected Output Structure

The vision processing generates a package containing scene segments and metadata:

```json
{
  "packageId": "segment_code",
  "preset": "vision-chunks",
  "fileId": "abc123def456",
  "resolution": {
    "width": 1280,
    "height": 720
  },
  "totalDuration": 120.5,
  "sceneThreshold": 0.4,
  "segments": [
    {
      "index": 0,
      "start": 0.0,
      "duration": 15.2,
      "url": "segment_code/scene_000.mp4"
    },
    {
      "index": 1,
      "start": 15.2,
      "duration": 22.8,
      "url": "segment_code/scene_001.mp4"
    }
  ]
}
```
