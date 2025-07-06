import { $ } from 'bun';
import path from 'path';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { META_DIR, TEMP_DIR } from './dirs.ts';
import { logTask, type Task, updateTask } from './tasks';
import { getFile, updateFile, type UserFile } from './files';
import {
  cleanupFile,
  cleanupFiles,
  downloadFromS3ToDisk,
  handleS3DownAndUpAppend,
  handleS3DownAndUpSwap,
  uploadToS3FromDisk,
  spaces,
} from './s3.ts';
import { tryCatch } from './promises.ts';
import type {
  AddAudioTrackType,
  AudioCodec,
  AudioFormat,
  CutEndType,
  DashType,
  ExtractAudioType,
  ExtractThumbnailType,
  MergeMediaType,
  RemoveAudioType,
  ResizeVideoType,
  TranscodeType,
  TrimType,
  VideoCodec,
  VideoFormat,
} from './schemas.ts';

export function transcode(args: TranscodeType, task: Task) {
  validateMuxCombination(args.format, args.video_codec || null, args.audio_codec || null);

  const outputFile = args.mode === 'replace' ? `${task.code}.${args.format}` : `${nanoid(8)}.${args.format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    fileIds: [args.file_id],
    outputFile,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasVideo = await checkFileHasVideoStream(inputFile);
      if (!hasVideo) throw new Error('File has no video track');

      return runFFmpeg([
        "-i", inputFile,
        ...(args.video_codec ? ["-c:v", args.video_codec] : []),
        ...(args.audio_codec ? ["-c:a", args.audio_codec] : []),
        outputPath,
      ], task);
    },
  });
}

export function resizeVideo(args: ResizeVideoType, task: Task) {
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.output_format}` : `${nanoid(8)}.${args.output_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    fileIds: [args.file_id],
    outputFile,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasVideo = await checkFileHasVideoStream(inputFile);
      if (!hasVideo) throw new Error('File has no video track');

      return runFFmpeg(['-i', inputPaths[0]!, '-vf', `scale=${args.width}:${args.height}`, outputPath], task);
    },
  });
}

export function trim(args: TrimType, task: Task) {
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.output_format}` : `${nanoid(8)}.${args.output_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    fileIds: [args.file_id],
    outputFile,
    operation: ({ inputPaths, outputPath }) => {
      return runFFmpeg(
        ['-i', inputPaths[0]!, '-ss', args.start.toString(), '-t', args.duration.toString(), '-c', 'copy', outputPath],
        task,
      );
    },
  });
}

export function cutEnd(args: CutEndType, task: Task) {
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.output_format}` : `${nanoid(8)}.${args.output_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    fileIds: [args.file_id],
    outputFile,
    operation: async ({ inputPaths, outputPath }) => {
      const totalDuration = await getVideoDuration(inputPaths[0]!);
      const keepDuration = totalDuration - args.duration;
      if (keepDuration <= 0) throw new Error("Resulting video would be empty");

      void runFFmpeg(["-i", inputPaths[0]!, "-t", keepDuration.toFixed(2), "-c", "copy", outputPath], task);
    },
  });
}

export function extractAudio(args: ExtractAudioType, task: Task) {
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.audio_format}` : `${nanoid(8)}.${args.audio_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    fileIds: [args.file_id],
    outputFile,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasAudio = await checkFileHasAudioStream(inputFile);
      if (!hasAudio) throw new Error('File has no audio track');

      return runFFmpeg(["-i", inputFile, "-vn", ...getAudioCodecs(args.audio_format), outputPath], task);
    },
  });
}

export function removeAudio(args: RemoveAudioType, task: Task) {
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.output_format}` : `${nanoid(8)}.${args.output_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    fileIds: [args.file_id],
    outputFile,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasAudio = await checkFileHasAudioStream(inputFile);
      if (!hasAudio) throw new Error('File has no audio track');

      return runFFmpeg(['-i', inputPaths[0]!, '-an', outputPath], task);
    },
  });
}

export function addAudioTrack(args: AddAudioTrackType, task: Task) {
  return handleS3DownAndUpAppend({
    task,
    fileIds: [args.video_file_id, args.audio_file_id],
    outputFile: `${nanoid(8)}.${args.output_format}`,
    operation: async ({ inputPaths, outputPath }) => {
      const videoPath = inputPaths[0]!;
      const audioPath = inputPaths[1]!;
      const hasVideo = await checkFileHasVideoStream(videoPath);
      if (!hasVideo) throw new Error('File has no video track');

      const audioCodecArgs = getAudioCodecsForVideo(path.extname(audioPath) as AudioFormat, args.output_format);
      await runFFmpeg([
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'copy',
        ...audioCodecArgs,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest', outputPath,
      ], task);
    },
  })
}

export function mergeMedia(args: MergeMediaType, task: Task) {
  return handleS3DownAndUpAppend({
    task: task,
    fileIds: args.file_ids,
    outputFile: `${nanoid(8)}.${args.output_format}`,
    operation: async ({ inputPaths, outputPath }) => {
      // Step 1: Probe first video for width and height
      const { data: probe, error: probeError } = await tryCatch(getVideoMetadata(inputPaths[0]!));
      if (probeError) {
        throw probeError;
      }
      const width = probe.resolution?.width;
      const height = probe.resolution?.height;

      if (!width || !height) {
        throw new Error('Could not resolve resolution for the output video');
      }

      // filter chains array
      const filterChains: string[] = [];
      // inputs to concat (scaled & padded video + audio pairs)
      const concatInputs: string[] = [];

      inputPaths.forEach((_, i) => {
        // Scale with aspect ratio preserved, then pad to exact size
        filterChains.push(
          `[${i}:v:0]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
        );
        concatInputs.push(`[v${i}][${i}:a:0]`);
      });

      const filterComplex = `${filterChains.join(";")};${concatInputs.join("")}concat=n=${inputPaths.length}:v=1:a=1[outv][outa]`;


      const { error } = await tryCatch(
        runFFmpeg([
          ...inputPaths.flatMap((path) => ["-i", path]),
          "-filter_complex", filterComplex,
          "-map", "[outv]",
          "-map", "[outa]",
          "-c:v", "libx264",
          "-preset", "fast",
          "-crf", "22",
          "-c:a", "aac",
          "-b:a", "192k",
          outputPath,
        ], task)
      );
      if (error) throw error;
    },
  });
}

export async function extractThumbnail(args: ExtractThumbnailType, task: Task) {
  return handleS3DownAndUpAppend({
    task,
    fileIds: [args.file_id],
    outputFile: `${nanoid(8)}.${args.image_format}`,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasVideo = await checkFileHasVideoStream(inputFile);

      if (!hasVideo) {
        throw new Error('File has no video track');
      }

      return runFFmpeg([
        '-i', inputPaths[0]!,
        '-ss', args.timestamp,
        '-vframes', '1',
        '-update', '1',
        "-q:v", "2",
        outputPath,
      ], task);
    },
  });
}

export async function generateDashFiles(args: DashType, task: Task) {
  const { data: file, error } = await tryCatch(getFile(task.file_id));
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

  const hasVideo = await checkFileHasVideoStream(localPath);
  if (!hasVideo) throw new Error('File has no video track');

  const ext = path.extname(file.file_name);
  const encodedPath = path.join(TEMP_DIR, `${task.code}${ext}`);

  const { error: ffError } = await tryCatch(
    runFFmpeg([
      '-i', localPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'fast',
      '-crf', '23',
      '-movflags', '+faststart',
      encodedPath,
    ], task)
  );
  if (ffError) {
    await cleanupFiles([localPath, encodedPath]);
    throw ffError;
  }

  const segmentsPath = path.join(TEMP_DIR, `${file.id}/dash`);
  await mkdir(segmentsPath, { recursive: true });
  const manifestoPath = path.join(segmentsPath, 'manifesto.mpd');

  const { error: mpError } = await tryCatch(
    runMp4box([
      '-dash', '4000',
      '-frag', '4000',
      '-profile', 'dashavc264:live',
      '-out', manifestoPath,
      encodedPath,
    ], task)
  );
  if (mpError) {
    await cleanupFiles([manifestoPath, encodedPath, localPath]);
    await rm(segmentsPath, { force: true, recursive: true });
    throw mpError;
  }

  const segmentedFiles = await readdir(segmentsPath, { withFileTypes: true });
  for (const seg of segmentedFiles) {
    if (seg.isDirectory()) continue;

    const segFilePath = path.join(seg.parentPath, seg.name);
    const { error: uploadError } = await tryCatch(uploadToS3FromDisk(segFilePath, `${file.id}/dash/${seg.name}`));
    if (uploadError) {
      await rm(segmentsPath, { force: true, recursive: true });
      throw new Error(`Failed to upload DASH segments for task ${task.id}`);
    }
  }

  if (await Bun.file(segmentsPath).exists()) {
    await rm(segmentsPath, { force: true, recursive: true });
  }
}

export async function updateFileMetadata(fileId: UserFile['id']) {
  const { meta, mimeType } = await getFileMetadata(fileId);
  return updateFile(fileId, { mime_type: mimeType, metadata: JSON.stringify(meta) });
}

export async function getFileMetadata(fileId: UserFile['id']) {
  const file = await getFile(fileId);
  if (!file) throw new Error(`File ${fileId} not found!`);

  const s3File = spaces.file(file.file_path);
  if (!(await s3File.exists())) {
    console.log('getFileMetadata - file not found on S3');
    throw new Error(`S3 File ${file.file_path} not found!`);
  }

  /**
   * Uses a separate **dir** and an extra **id** to avoid clashes with other async cleanup functions.
   */
  const inputPath = path.join(META_DIR, `${nanoid(8)}_${file.file_path}`);
  await downloadFromS3ToDisk(file.file_path, inputPath);
  const { data, error } = await tryCatch(getLocalFileMetadata(inputPath));
  await cleanupFile(inputPath);

  if (error) throw error;
  return data;
}

export async function getLocalFileMetadata(filePath: string) {
  const localFile = Bun.file(filePath);
  if (!await localFile.exists()) throw new Error(`File on ${filePath} not found!`);

  const mimeType = localFile.type;

  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');
  const isImage = mimeType.startsWith('image/');

  if (isVideo) {
    const { data: meta, error } = await tryCatch(getVideoMetadata(filePath));
    if (error) throw error;
    return { meta, mimeType };
  }

  if (isAudio) {
    const { data: meta, error } = await tryCatch(getAudioMetadata(filePath));
    if (error) throw error;
    return { meta, mimeType };
  }

  if (isImage) {
    const { data: meta, error } = await tryCatch(getImageMetadata(filePath));
    if (error) throw error;
    return { meta, mimeType };
  }

  throw new Error(`File on ${filePath} has unknown type: ${mimeType}`);
}

async function getVideoDuration(filePath: string) {
  const response = await $`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  return parseFloat(response.text().trim());
}

async function getVideoMetadata(inputPath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration,bit_rate,size",
    "-show_entries", "stream=width,height",
    "-of", "json",
    inputPath,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed: ${error}`);
  }

  const result = await new Response(proc.stdout).json() as any;
  const stream = result.streams?.[0];
  const format = result.format;

  return {
    size: format?.size ? parseInt(format.size, 10) : null,
    duration: format?.duration ? parseFloat(format.duration) : null,
    bit_rate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
    resolution: {
      width: stream?.width ? Number(stream.width) : null,
      height: stream?.height ? Number(stream.height) : null,
    },
  };
}

async function getAudioMetadata(inputPath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "format=duration,bit_rate,size",
    "-show_entries", "stream=sample_rate,channels",
    "-of", "json",
    inputPath,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed: ${error}`);
  }

  const result = await new Response(proc.stdout).json() as any;
  const stream = result.streams?.[0];
  const format = result.format;

  return {
    size: format?.size ? parseInt(format.size, 10) : null,
    duration: format?.duration ? parseFloat(format.duration) : null,
    bit_rate: format?.bit_rate ? parseInt(format.bit_rate, 10) : null,
    sample_rate: stream?.sample_rate ? parseInt(stream.sample_rate, 10) : null,
    channels: stream?.channels ?? null,
  };
}

async function getImageMetadata(inputPath: string) {
  const proc = Bun.spawn([
    "ffprobe",
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=width,height,color_range,color_space",
    "-of", "json",
    inputPath,
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed: ${error}`);
  }

  const result = await new Response(proc.stdout).json() as any;
  const stream = result.streams?.[0];
  const format = result.format;

  return {
    size: format?.size ? parseInt(format.size, 10) : null,
    color_range: stream?.color_range,
    color_space: stream?.color_space,
    resolution: {
      width: stream?.width ? Number(stream.width) : null,
      height: stream?.height ? Number(stream.height) : null,
    },
  };
}

async function checkFileHasVideoStream(filePath: string) {
  const result = await $`ffprobe -v quiet -print_format json -show_streams ${filePath}`;
  const parsed = JSON.parse(result.stdout.toString());

  return (parsed.streams as any[]).some((s: any) => s.codec_type === "video");
}

async function checkFileHasAudioStream(filePath: string) {
  const result = await $`ffprobe -v quiet -print_format json -show_streams ${filePath}`;
  const parsed = JSON.parse(result.stdout.toString());

  return (parsed.streams as any[]).some((s: any) => s.codec_type === "audio");
}

function getAudioCodecs(format: AudioFormat): string[] {
  switch (format.toLowerCase()) {
    case "mp3":
      return ["-acodec", "libmp3lame", "-q:a", "2"]; // Good quality
    case "aac":
    case "m4a":
      return ["-acodec", "aac", "-b:a", "192k"]; // Bitrate encoding
    case "wav":
      return ["-acodec", "pcm_s16le"]; // Raw WAV audio
    case "flac":
      return ["-acodec", "flac"];
    case "opus":
      return ["-acodec", "libopus", "-b:a", "128k"];
    default:
      throw new Error(`Unsupported audio format: ${format}`);
  }
}

function getAudioCodecsForVideo(audioFormat: AudioFormat, outputFormat: VideoFormat): string[] {
  // Always re-encode if incompatible
  switch (outputFormat) {
    case "mp4":
    case "mov":
      return audioFormat === "aac" || audioFormat === "mp3"
        ? ["-c:a", "copy"]
        : ["-c:a", "aac", "-b:a", "192k"];

    case "webm":
      return audioFormat === "opus"
        ? ["-c:a", "copy"]
        : ["-c:a", "libopus", "-b:a", "128k"];

    case "mkv":
      // MKV supports most codecs, but safest default is AAC
      return audioFormat === "aac" || audioFormat === "mp3" || audioFormat === "flac" || audioFormat === "opus"
        ? ["-c:a", "copy"]
        : ["-c:a", "aac", "-b:a", "192k"];

    case "avi":
      return audioFormat === "mp3" || audioFormat === "wav"
        ? ["-c:a", "copy"]
        : ["-c:a", "mp3"];

    default:
      throw new Error(`Unsupported output format: ${outputFormat}`);
  }
}

function validateMuxCombination(
  outputFormat: VideoFormat | AudioFormat,
  videoCodec: VideoCodec | null,
  audioCodec: AudioCodec | null,
): void {
  // Common video formats
  if (outputFormat === "mp4" || outputFormat === "mov") {
    if (videoCodec && !["h264", "hevc", "mpeg4"].includes(videoCodec)) {
      throw new Error(`Video codec ${videoCodec} is not typically compatible with ${outputFormat}`);
    }
    if (audioCodec && !["aac", "mp3"].includes(audioCodec)) {
      throw new Error(`Audio codec ${audioCodec} is not typically compatible with ${outputFormat}`);
    }
  } else if (outputFormat === "mkv") {
    // MKV is very flexible, but some common sense checks can still apply
    if (videoCodec && !["h264", "hevc", "vp9", "av1"].includes(videoCodec)) {
      console.warn(`Video codec ${videoCodec} is less common with ${outputFormat}, but might work.`);
    }
    if (audioCodec && !["aac", "mp3", "ac3", "opus", "flac"].includes(audioCodec)) {
      console.warn(`Audio codec ${audioCodec} is less common with ${outputFormat}, but might work.`);
    }
  } else if (outputFormat === "webm") {
    if (videoCodec && !["vp8", "vp9", "av1"].includes(videoCodec)) {
      throw new Error(`Video codec ${videoCodec} is not compatible with ${outputFormat}`);
    }
    if (audioCodec && !["opus", "vorbis"].includes(audioCodec)) {
      throw new Error(`Audio codec ${audioCodec} is not compatible with ${outputFormat}`);
    }
  } else if (outputFormat === "avi") {
    // AVI is older and less flexible
    if (videoCodec && !["mpeg4", "msmpeg4", "libxvid"].includes(videoCodec)) {
      throw new Error(`Video codec ${videoCodec} is not typically compatible with ${outputFormat}`);
    }
    if (audioCodec && !["mp3", "ac3"].includes(audioCodec)) {
      throw new Error(`Audio codec ${audioCodec} is not typically compatible with ${outputFormat}`);
    }
  }

  // Common audio formats (when videoCodec is null, meaning extracting audio)
  if (!videoCodec && (outputFormat === "mp3" || outputFormat === "m4a" || outputFormat === "aac" || outputFormat === "flac" || outputFormat === "wav" || outputFormat === "opus")) {
    if (audioCodec && outputFormat !== audioCodec) {
      // Basic check: if output is an audio format, audio codec should ideally match or be compatible
      console.warn(`Output format ${outputFormat} and audio codec ${audioCodec} might not be a direct match.`);
    }
  }
}


async function runFFmpeg(args: string[], task: Task) {
  logOperation(JSON.stringify(["ffmpeg", ...args]));

  const proc = Bun.spawn(["ffmpeg", ...args], {
    timeout: 1000 * 60 * 15, // 15 minutes
  });

  await updateTask(task.id, { pid: proc.pid });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    logTask(task.id, `ffmpeg finished with exit code ${proc.exitCode} (${proc.signalCode})`);
    throw new Error(error);
  }

  logTask(task.id, 'ffmpeg finished with exit code 0');
}

async function runMp4box(args: string[], task: Task) {
  logOperation(JSON.stringify(["mp4box", ...args]));

  const proc = Bun.spawn(["mp4box", ...args], {
    timeout: 1000 * 60 * 15, // 15 minutes
  });

  await updateTask(task.id, { pid: proc.pid });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    logTask(task.id, `mp4box finished with exit code ${proc.exitCode} (${proc.signalCode})`);
    throw new Error(error);
  }

  logTask(task.id, 'mp4box finished with exit code 0');
}

export function logOperation(message: string) {
  console.log(`------- FFmpeg: ------------`);
  console.log(message);
  console.log(' ');
}
