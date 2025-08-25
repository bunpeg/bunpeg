# ASR (Speech-to-Text Preparation) Implementation Guide

## Overview

This document provides detailed implementation instructions for adding ASR (Automatic Speech Recognition) basic functionality to the bunpeg project. The ASR feature prepares audio and video files for speech-to-text processing by extracting/normalizing audio, detecting silence, and creating optimally-sized segments.

## Feature Requirements

### Goal
Produce clean mono WAV segments (~60–120s) with normalized loudness suitable for ASR processing from audio or video files.

### Processing Steps
1. **Extract/Normalize Audio**: Extract audio from video (if needed) and normalize using EBU R128 standard
2. **Analyze Silence**: Detect silence regions to plan optimal segmentation
3. **Create Segments**: Export audio segments based on analysis with manifest

### Output Format
- Multiple WAV files (seg_000.wav, seg_001.wav, etc.)
- Package manifest JSON with metadata and segment URLs

## Architecture Design

### Task-Based Processing
The ASR feature uses the existing task queue system with conditional workflows:

**For video files**: `extract-audio` → `asr-normalize` → `asr-analyze` → `asr-segment`
**For audio files**: `asr-normalize` → `asr-analyze` → `asr-segment`

Internal ASR operations:
1. `asr-normalize` - Audio normalization for ASR (assumes audio input)
2. `asr-analyze` - Silence detection and segment planning
3. `asr-segment` - Segment creation and manifest generation

### API Security
- Only `/asr` endpoint is public-facing
- Internal operations (`asr-normalize`, `asr-analyze`, `asr-segment`) are not accessible via `/chain` or `/bulk`
- Direct task creation at endpoint level

## Implementation Steps

### Step 1: Update Schemas (`src/utils/schemas.ts`)

#### Add ASR Types and Schemas

```typescript
// Public ASR request schema (for endpoint validation)
export const AsrParams = z.object({
  max_segment_duration: z.number().min(30).max(180).default(120),
  min_segment_duration: z.number().min(10).max(90).default(30),
  silence_threshold: z.string().default("-40dB"),
  silence_duration: z.number().default(0.5),
  mode: mode.default('append'),
  parent: parentId,
});

export const AsrSchema = AsrParams.extend({ file_id: fileId });
export type AsrType = z.infer<typeof AsrSchema>;

// Internal ASR operation schemas (NOT exposed to users)
export const AsrNormalizeSchema = z.object({
  file_id: fileId,
  mode: mode.default('append'),
  parent: parentId,
});
export type AsrNormalizeType = z.infer<typeof AsrNormalizeSchema>;

export const AsrAnalyzeSchema = z.object({
  file_id: fileId,
  max_segment_duration: z.number(),
  min_segment_duration: z.number(),
  silence_threshold: z.string(),
  silence_duration: z.number(),
  mode: mode.default('append'),
  parent: parentId,
});
export type AsrAnalyzeType = z.infer<typeof AsrAnalyzeSchema>;

export const AsrSegmentSchema = z.object({
  file_id: fileId,
  analysis_file_id: fileId,
  mode: mode.default('append'),
  parent: parentId,
});
export type AsrSegmentType = z.infer<typeof AsrSegmentSchema>;
```

#### Update Operation Types

```typescript
// Add to Operations union (after existing types)
export type Operations =
  | TranscodeType
  | ResizeVideoType
  | TrimType
  | CutEndType
  | ExtractAudioType
  | AddAudioTrackType
  | RemoveAudioType
  | MergeMediaType
  | ExtractThumbnailType
  | DashType
  | AsrNormalizeType
  | AsrAnalyzeType
  | AsrSegmentType;

// Add internal ASR operations to OperationName (after existing operations)
export type OperationName = ChainType['operations'][number]['type']
  | 'add-audio'
  | 'merge-media'
  | 'dash'
  | 'asr-normalize'
  | 'asr-analyze'
  | 'asr-segment';
```

**Important**: Do NOT add ASR operations to `ChainOperationSchema` - they should remain internal only.

### Step 2: Create ASR Utilities (`src/utils/asr.ts`)

```typescript
import { $ } from "bun";

export interface SilenceEvent {
  type: "start" | "end";
  time: number;
}

export interface AudioSegment {
  index: number;
  start: number;
  duration: number;
}

export interface AsrManifest {
  packageId: string;
  preset: "asr-basic";
  fileId: string;
  sampleRate: 16000;
  channels: 1;
  segments: Array<{
    index: number;
    start: number;
    duration: number;
    url: string;
  }>;
}

/**
 * Detect silence regions in audio file using FFmpeg
 */
export async function detectSilence(
  filePath: string,
  threshold = "-40dB",
  minDur = 0.5
): Promise<SilenceEvent[]> {
  const { stderr } = await $`ffmpeg -i ${filePath} -af silencedetect=n=${threshold}:d=${minDur} -f null -`.quiet();
  const lines = stderr.toString().split("\n");
  const events: SilenceEvent[] = [];

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/);

    if (startMatch) {
      events.push({ type: "start", time: parseFloat(startMatch[1]) });
    }
    if (endMatch) {
      events.push({ type: "end", time: parseFloat(endMatch[1]) });
    }
  }

  return events;
}

/**
 * Plan optimal audio chunks based on silence detection
 */
export function planAudioChunks(
  duration: number,
  maxChunk = 120,
  minChunk = 30,
  silenceEvents: SilenceEvent[]
): AudioSegment[] {
  // Extract silence cut points (start of silence regions)
  const silenceCuts = silenceEvents
    .filter(event => event.type === "start")
    .map(event => event.time)
    .filter(time => time > 5 && time < duration - 5);

  const cuts = [0, ...silenceCuts, duration].sort((a, b) => a - b);
  const segments: AudioSegment[] = [];
  let start = 0;
  let index = 0;

  for (const cut of cuts) {
    if (cut - start >= minChunk) {
      const end = Math.min(start + maxChunk, cut);
      segments.push({
        index,
        start,
        duration: +(end - start).toFixed(3)
      });
      start = end;
      index++;
    }
  }

  // Handle remaining duration
  if (duration - start > 5) {
    segments.push({
      index,
      start,
      duration: +(duration - start).toFixed(3)
    });
  }

  return segments;
}

/**
 * Get audio duration using FFprobe
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await $`ffprobe -v quiet -show_entries format=duration -of csv=p=0 ${filePath}`;
  return parseFloat(stdout.toString().trim());
}

/**
 * Create ASR package manifest
 */
export function createAsrManifest(
  packageId: string,
  fileId: string,
  segments: AudioSegment[],
  baseUrl: string = ""
): AsrManifest {
  return {
    packageId,
    preset: "asr-basic",
    fileId,
    sampleRate: 16000,
    channels: 1,
    segments: segments.map(segment => ({
      index: segment.index,
      start: segment.start,
      duration: segment.duration,
      url: `${baseUrl}/output/seg_${segment.index.toString().padStart(3, '0')}.wav`
    }))
  };
}
```

### Step 3: Add ASR Processing Functions (`src/utils/ffmpeg.ts`)

Add these functions to the existing ffmpeg.ts file:

```typescript
import type { AsrNormalizeType, AsrAnalyzeType, AsrSegmentType } from './schemas.ts';
import { detectSilence, planAudioChunks, getAudioDuration, createAsrManifest, type AudioSegment } from './asr.ts';

/**
 * ASR Step 1: Normalize audio for ASR processing (assumes audio input)
 * This function expects audio input - video files should use extract-audio task first
 */
export function asrNormalize(args: AsrNormalizeType, task: Task) {
  const outputFile = `${task.code}_normalized.wav`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;

  return s3Operation({
    task,
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;

      // Input should already be audio (either original audio file or extracted from video)
      const hasAudio = await checkFileHasAudioStream(inputFile);
      if (!hasAudio) throw new Error('Expected audio input for ASR normalization');

      // Normalize for ASR: mono, 16kHz, EBU R128
      return runFFmpeg([
        "-i", inputFile,
        "-ac", "1",                // Downmix to mono
        "-ar", "16000",            // 16kHz sample rate
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",  // EBU R128 normalization
        outputPath
      ], { timeout: 15 * 60 * 1000 });
    }
  });
}

/**
 * ASR Step 2: Analyze silence and plan segmentation
 */
export function asrAnalyze(args: AsrAnalyzeType, task: Task) {
  const outputFile = `${task.code}_analysis.json`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;

  return s3Operation({
    task,
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;

      // Get audio duration
      const duration = await getAudioDuration(inputFile);

      // Detect silence regions
      const silenceEvents = await detectSilence(
        inputFile,
        args.silence_threshold,
        args.silence_duration
      );

      // Plan audio segments
      const segments = planAudioChunks(
        duration,
        args.max_segment_duration,
        args.min_segment_duration,
        silenceEvents
      );

      // Save analysis results
      const analysisData = {
        duration,
        silenceEvents,
        segments,
        parameters: {
          max_segment_duration: args.max_segment_duration,
          min_segment_duration: args.min_segment_duration,
          silence_threshold: args.silence_threshold,
          silence_duration: args.silence_duration
        }
      };

      await Bun.write(outputPath, JSON.stringify(analysisData, null, 2));

      return { success: true };
    }
  });
}

/**
 * ASR Step 3: Create audio segments and manifest
 */
export function asrSegment(args: AsrSegmentType, task: Task) {
  const outputFile = `${task.code}_manifest.json`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;

  return s3Operation({
    task,
    outputFile,
    fileIds: [args.file_id, args.analysis_file_id],
    parentFile: args.parent,
    operation: async ({ inputPaths, outputPath }) => {
      const normalizedAudioPath = inputPaths[0]!;
      const analysisPath = inputPaths[1]!;

      // Load analysis results
      const analysisData = JSON.parse(await Bun.file(analysisPath).text());
      const segments: AudioSegment[] = analysisData.segments;

      // Create output directory for segments
      const segmentDir = path.dirname(outputPath);
      await mkdir(segmentDir, { recursive: true });

      // Create each audio segment
      const segmentFiles: string[] = [];
      for (const segment of segments) {
        const segmentFileName = `seg_${segment.index.toString().padStart(3, '0')}.wav`;
        const segmentPath = path.join(segmentDir, segmentFileName);

        await runFFmpeg([
          "-i", normalizedAudioPath,
          "-ss", segment.start.toString(),
          "-t", segment.duration.toString(),
          "-c", "copy",  // Copy codec for speed
          segmentPath
        ]);

        segmentFiles.push(segmentFileName);
      }

      // Create package manifest
      const manifest = createAsrManifest(
        task.code,
        args.file_id,
        segments,
        "/output" // Base URL for segment access
      );

      // Save manifest
      await Bun.write(outputPath, JSON.stringify(manifest, null, 2));

      return { success: true, segmentFiles };
    }
  });
}
```

### Step 4: Update Queue System (`src/utils/queue-ff.ts`)

Add ASR operation cases to the switch statement in `runOperation()`:

```typescript
// Add after existing cases in the switch statement

case 'asr-normalize': {
  const parsed = AsrNormalizeSchema.safeParse(JSON.parse(jsonArgs));
  if (!parsed.success) throw new Error(`Invalid asr-normalize args: ${JSON.stringify(parsed.error.issues)}`);
  const args = parsed.data;
  await asrNormalize(args, task);
} break;

case 'asr-analyze': {
  const parsed = AsrAnalyzeSchema.safeParse(JSON.parse(jsonArgs));
  if (!parsed.success) throw new Error(`Invalid asr-analyze args: ${JSON.stringify(parsed.error.issues)}`);
  const args = parsed.data;
  await asrAnalyze(args, task);
} break;

case 'asr-segment': {
  const parsed = AsrSegmentSchema.safeParse(JSON.parse(jsonArgs));
  if (!parsed.success) throw new Error(`Invalid asr-segment args: ${JSON.stringify(parsed.error.issues)}`);
  const args = parsed.data;
  await asrSegment(args, task);
} break;
```

### Step 5: Add API Endpoint (`src/index.ts`)

Add the `/asr` endpoint to the routes object:

```typescript
"/asr": {
  OPTIONS: async () => {
    return new Response('OK', { headers: CORS_HEADERS });
  },
  POST: async (req) => {
    const body = await req.json();
    const parsed = AsrSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: parsed.error }), {
        status: 400,
        headers: CORS_HEADERS
      });
    }

    const args = parsed.data;

    try {
      let normalizeInputFileId = args.file_id;

      // Check if input is video file
      const file = await getFile(args.file_id);
      const filePath = await downloadFromS3ToDisk(file); // Temp download for analysis
      const hasVideo = await checkFileHasVideoStream(filePath);
      await cleanupFile(filePath); // Clean up temp file

      if (hasVideo) {
        // Create extract-audio task first for video files
        await createTask(args.file_id, 'extract-audio', {
          file_id: args.file_id,
          audio_format: 'wav',
          mode: 'append',
          parent: args.parent,
        });

        // Note: Subsequent tasks will reference the extracted audio file
        // This requires file ID chaining system to be implemented
        // For now, using original file_id - needs improvement
      }

      // Create ASR-specific tasks
      await createTask(normalizeInputFileId, 'asr-normalize', {
        file_id: normalizeInputFileId,
        mode: 'append',
        parent: args.parent,
      });

      // Task 2: Analyze silence (depends on normalized audio)
      await createTask(normalizeInputFileId, 'asr-analyze', {
        file_id: normalizeInputFileId, // This should reference normalized file
        max_segment_duration: args.max_segment_duration,
        min_segment_duration: args.min_segment_duration,
        silence_threshold: args.silence_threshold,
        silence_duration: args.silence_duration,
        mode: 'append',
        parent: args.parent,
      });

      // Task 3: Create segments (depends on normalized audio + analysis)
      await createTask(normalizeInputFileId, 'asr-segment', {
        file_id: normalizeInputFileId, // This should reference normalized file
        analysis_file_id: normalizeInputFileId, // This should reference analysis file
        mode: 'append',
        parent: args.parent,
      });

      return Response.json({ success: true }, { headers: CORS_HEADERS });

    } catch (error) {
      return new Response(JSON.stringify({
        error: "Failed to create ASR tasks",
        details: error instanceof Error ? error.message : String(error)
      }), {
        status: 500,
        headers: CORS_HEADERS
      });
    }
  }
},
```



## Implementation Notes

### Leveraging Existing Functionality
- Uses existing `extract-audio` task for video files without modification
- `asr-normalize` focuses only on ASR-specific normalization
- Reuses existing helpers like `checkFileHasVideoStream()` and `checkFileHasAudioStream()`
- Maximum separation of concerns and code reuse

### File ID Chaining
The current implementation has a limitation: sequential tasks need to reference outputs from previous tasks. Consider implementing a task dependency system or file ID chaining mechanism.

### Error Handling
- Each ASR operation should handle FFmpeg errors gracefully
- Failed tasks should mark subsequent tasks as unreachable
- Provide meaningful error messages for debugging
- Temporary files are cleaned up even on errors

### Performance Considerations
- Video files require separate extraction task before ASR processing
- Audio extraction and normalization are handled as separate tasks for better queue distribution
- Consider timeout values for large files
- Segment creation is generally fast with copy codec

### Storage Management
- Intermediate files (normalized audio, analysis) may be large
- Video files will generate additional intermediate audio files
- Consider cleanup policies for temporary files
- Segment files will multiply storage usage

### Testing
1. Test with various audio formats (MP3, WAV, M4A)
2. Test with various video formats (MP4, MKV, AVI, MOV)
3. Test with different duration files (short, medium, long)
4. Test silence detection with different threshold values
5. Verify segment timing accuracy
6. Test error scenarios (corrupted files, insufficient disk space)
7. Test video files with no audio track (should fail gracefully)
8. Test audio-only files vs video files with different codecs

## API Usage Example

```bash
# Upload audio or video file first
curl -X POST http://localhost:3000/upload \
  -F "file=@speech.mp3"
  # or
  # -F "file=@video-with-speech.mp4"

# Start ASR processing
curl -X POST http://localhost:3000/asr \
  -H "Content-Type: application/json" \
  -d '{
    "file_id": "abc123",
    "max_segment_duration": 90,
    "min_segment_duration": 45,
    "silence_threshold": "-35dB",
    "silence_duration": 1.0
  }'

# Check processing status
curl http://localhost:3000/status/abc123

# Download manifest when complete
curl http://localhost:3000/output/manifest_file_id
```

## Expected Output Structure

```
Processed Files:
├── abc123_normalized.wav      # Extracted/normalized mono audio
├── abc123_analysis.json       # Silence analysis results
├── abc123_manifest.json       # Package manifest
├── seg_000.wav               # First audio segment
├── seg_001.wav               # Second audio segment
└── ...                       # Additional segments
```

Manifest JSON format:
```json
{
  "packageId": "pkg_abc123",
  "preset": "asr-basic",
  "fileId": "abc123",
  "sampleRate": 16000,
  "channels": 1,
  "segments": [
    {
      "index": 0,
      "start": 0,
      "duration": 58.2,
      "url": "/output/seg_000.wav"
    },
    {
      "index": 1,
      "start": 58.2,
      "duration": 59.9,
      "url": "/output/seg_001.wav"
    }
  ]
}
```
