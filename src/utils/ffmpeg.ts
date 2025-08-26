import { $ } from 'bun';
import path from 'path';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { META_DIR, TEMP_DIR } from './dirs.ts';
import { logTask, type Task, updateTask } from './tasks';
import { getFile, updateFile, type UserFile } from './files';
import {
  cleanupFile,
  downloadFromS3ToDisk,
  handleS3DownAndUpAppend,
  handleS3DownAndUpSwap,
  uploadToS3FromDisk,
  spaces,
  cleanupFiles,
} from './s3.ts';
import { tryCatch } from './promises.ts';
import type {
  AddAudioTrackType,
  AsrAnalyzeType,
  AsrNormalizeType,
  AsrSegmentType,
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
import { detectSilence, planAudioChunks, getAudioDuration, createAsrManifest, type AudioSegment } from './asr.ts';

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
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
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
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
    operation: ({ inputPaths, outputPath }) => {
      const outputEncoding = args.exact ? ['-c:v', 'libx264', '-c:a', 'aac'] : ['-c', 'copy'];
      return runFFmpeg(
        ['-i', inputPaths[0]!, '-ss', args.start.toString(), '-t', args.duration.toString(), ...outputEncoding, outputPath],
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
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
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
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
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
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
    operation: async ({ inputPaths, outputPath }) => {
      const inputFile = inputPaths[0]!;
      const hasAudio = await checkFileHasAudioStream(inputFile);
      if (!hasAudio) throw new Error('File has no audio track');

      return runFFmpeg(['-i', inputPaths[0]!, '-an', outputPath], task);
    },
  });
}

export function addAudioTrack(args: AddAudioTrackType, task: Task) {
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.output_format}` : `${nanoid(8)}.${args.output_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    outputFile,
    parentFile: args.parent ?? args.video_file_id,
    fileIds: [args.video_file_id, args.audio_file_id],
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
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.output_format}` : `${nanoid(8)}.${args.output_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task: task,
    outputFile,
    fileIds: args.file_ids,
    parentFile: args.parent ?? args.file_ids[0],
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
  const outputFile = args.mode === 'replace' ? `${task.code}.${args.image_format}` : `${nanoid(8)}.${args.image_format}`;
  const s3Operation = args.mode === 'replace' ? handleS3DownAndUpSwap : handleS3DownAndUpAppend;
  return s3Operation({
    task,
    outputFile,
    fileIds: [args.file_id],
    parentFile: args.parent,
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

  const hasVideo = await checkFileHasVideoStream(localPath);
  if (!hasVideo) throw new Error('File has no video track');

  const segmentsPath = path.join(TEMP_DIR, `${file.id}/dash`);
  await mkdir(segmentsPath, { recursive: true });
  const manifestoPath = path.join(segmentsPath, 'manifesto.mpd');

  const { error: ffmpegError } = await tryCatch(
    runFFmpeg([
      '-i', localPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'fast',
      '-crf', '23',
      '-f', 'dash',
      '-seg_duration', '4',
      '-use_timeline', '1',
      '-use_template', '1',
      '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
      manifestoPath,
    ], task)
  );

  if (ffmpegError) {
    console.error('FFmpeg error:', ffmpegError);
    await cleanupFile(localPath);
    await rm(segmentsPath, { force: true, recursive: true });
    throw new Error(`Failed to generate DASH segments for task ${task.id}`);
  }

  const segmentedFiles = await readdir(segmentsPath, { withFileTypes: true });
  for (const seg of segmentedFiles) {
    if (seg.isDirectory()) continue;

    const segFilePath = path.join(seg.parentPath, seg.name);
    const { error: uploadError } = await tryCatch(uploadToS3FromDisk(segFilePath, `${file.id}/dash/${seg.name}`, { acl: 'public-read' }));
    if (uploadError) {
      await cleanupFile(localPath);
      await rm(segmentsPath, { force: true, recursive: true });
      throw new Error(`Failed to upload DASH segments for task ${task.id}`);
    }
  }

  if (await Bun.file(segmentsPath).exists()) {
    await rm(segmentsPath, { force: true, recursive: true });
  }

  await cleanupFile(localPath);
}

/**
 * ASR Step 1: Normalize audio for ASR processing (assumes audio input)
 * This function expects audio input - video files should use extract-audio task first
 */
export function asrNormalize(args: AsrNormalizeType, task: Task) {
  const outputFile = `${task.code}_normalized.wav`;

  return handleS3DownAndUpSwap({
    task,
    outputFile,
    s3UploadPath: `${args.file_id}/asr/normalized.wav`,
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
      ], task);
    }
  });
}

/**
 * ASR Step 2: Analyze silence and plan segmentation
 */
export function asrAnalyze(args: AsrAnalyzeType, task: Task) {
  const outputFile = `${task.code}_analysis.json`;

  return handleS3DownAndUpAppend({
    task,
    outputFile,
    s3UploadPath: `${args.file_id}/asr/analysis.json`,
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
    }
  });
}

/**
 * ASR Step 3: Create audio segments and manifest
 */
export async function asrSegment(args: AsrSegmentType, task: Task) {
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
  const { error: analisysDownloadError } = await tryCatch(downloadFromS3ToDisk(`${file.id}/asr/analysis.json`, analysisPath));
  if (analisysDownloadError) {
    logTask(task.id, `Failed to download analysis file ${file.id}/asr/analysis.json from S3`);
    await cleanupFiles([localPath, analysisPath]);
    throw downloadError;
  }

  const segmentsPath = path.join(TEMP_DIR, `${file.id}/asr`);
  await mkdir(segmentsPath, { recursive: true });
  const manifestPath = path.join(segmentsPath, 'manifest.json');

  // Load analysis results
  const analysisData = JSON.parse(await Bun.file(analysisPath).text());
  const segments: AudioSegment[] = analysisData.segments;

  // Create each audio segment
  const segmentFiles: string[] = [];
  for (const segment of segments) {
    const segmentFileName = `seg_${segment.index.toString().padStart(3, '0')}.wav`;
    const segmentPath = path.join(segmentsPath, segmentFileName);

    await runFFmpeg([
      "-i", localPath,
      "-ss", segment.start.toString(),
      "-t", segment.duration.toString(),
      "-c", "copy",  // Copy codec for speed
      segmentPath
    ], task);

    segmentFiles.push(segmentFileName);
  }

  // Create package manifest
  const manifest = createAsrManifest(
    task.code,
    args.file_id,
    segments,
    `https://bunpeg.fra1.cdn.digitaloceanspaces.com/${file.id}/asr` // Base URL for segment access
  );

  // Save manifest
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  const { error: manifestUploadError } = await tryCatch(uploadToS3FromDisk(manifestPath, `${file.id}/asr/manifest.json`, { acl: 'public-read' }));
  if (manifestUploadError) {
    await cleanupFiles([localPath, analysisPath, manifestPath]);
    await rm(segmentsPath, { force: true, recursive: true });
    throw new Error(`Failed to upload ASR manifest for task ${task.id}`);
  }

  const segmentedFiles = await readdir(segmentsPath, { withFileTypes: true });
  for (const seg of segmentedFiles) {
    if (seg.isDirectory()) continue;

    const segFilePath = path.join(seg.parentPath, seg.name);
    const { error: uploadError } = await tryCatch(uploadToS3FromDisk(segFilePath, `${file.id}/asr/${seg.name}`, { acl: 'public-read' }));
    if (uploadError) {
      await cleanupFiles([localPath, analysisPath, manifestPath]);
      await rm(segmentsPath, { force: true, recursive: true });
      throw new Error(`Failed to upload ASR segments for task ${task.id}`);
    }
  }

  if (await Bun.file(segmentsPath).exists()) {
    await rm(segmentsPath, { force: true, recursive: true });
  }

  await cleanupFile(localPath);
}

/**
 * Similar to the `getFileMetadata` function, this function probes the content of a file and returns its metadata.
 * However, this functions gathers more information about the streams, keyframes... and as a result it is more expensive to run.
 * @param fileId The ID of the file to probe.
 * @returns A promise that resolves to the metadata of the file.
 */
export async function probeFileContent(fileId: UserFile['id']) {
  const file = await getFile(fileId);
  if (!file) throw new Error(`File ${fileId} not found!`);

  const s3File = spaces.file(file.file_path);
  if (!(await s3File.exists())) {
    console.log('probeFileContent - file not found on S3');
    throw new Error(`S3 File ${file.file_path} not found!`);
  }

  /**
   * Uses a separate **dir** and an extra **id** to avoid clashes with other async cleanup functions.
   */
  const inputPath = path.join(META_DIR, `${nanoid(8)}_${file.file_path}`);
  await downloadFromS3ToDisk(file.file_path, inputPath);

  try {
    // Get comprehensive stream information
    const streamsProc = Bun.spawn([
      "ffprobe",
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-of", "json",
      inputPath,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await streamsProc.exited;

    if (streamsProc.exitCode !== 0) {
      const error = await new Response(streamsProc.stderr).text();
      throw new Error(`ffprobe failed: ${error}`);
    }

    const streamsResult = await new Response(streamsProc.stdout).json() as any;
    const streams = streamsResult.streams || [];
    const format = streamsResult.format || {};

    // Check for audio and video streams
    const hasAudio = streams.some((s: any) => s.codec_type === 'audio');
    const hasVideo = streams.some((s: any) => s.codec_type === 'video');

    // Get loudness information for audio streams (EBU R128)
    const resolveLoudnessInfo = async () => {
      const loudnessProc = Bun.spawn([
        "ffmpeg",
        "-i", inputPath,
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
        "-f", "null",
        "-"
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await loudnessProc.exited;
      const loudnessOutput = await new Response(loudnessProc.stderr).text();

      // Extract JSON from the loudness output
      const jsonMatch = loudnessOutput.match(/\{[^}]*"input_i"[^}]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    };

    let loudnessInfo = null;
    if (hasAudio) {
      const { data: __loudnessInfo, error: loudnessError } = await tryCatch(resolveLoudnessInfo());
      if (loudnessError) {
        console.warn('Failed to get loudness information:', loudnessError);
      } else {
        loudnessInfo = __loudnessInfo;
      }
    }

    // Get keyframes for video streams
    const resolveKeyframes = async () => {
      const keyframesProc = Bun.spawn([
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,flags",
        "-of", "csv=print_section=0",
        inputPath,
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      await keyframesProc.exited;

      if (keyframesProc.exitCode === 0) {
        const keyframesOutput = await new Response(keyframesProc.stdout).text();
        const lines = keyframesOutput.trim().split('\n');
        return lines
          .filter(line => line.includes('K'))  // K flag indicates keyframe
          .map(line => {
            const parts = line.split(',');
            return parseFloat(parts[0] || '0');
          })
          .filter(time => !isNaN(time));
      }

      return null;
    }

    let keyframes: number[] | null = null;
    if (hasVideo) {
      const { data: __keyframes, error: keyFramesError } = await tryCatch(resolveKeyframes());
      if (keyFramesError) {
        console.warn('Failed to get keyframes information:', keyFramesError);
      } else {
        keyframes = __keyframes;
      }
    }

    // Parse and structure the response
    const videoStreams = streams.filter((s: any) => s.codec_type === 'video');
    const audioStreams = streams.filter((s: any) => s.codec_type === 'audio');
    const subtitleStreams = streams.filter((s: any) => s.codec_type === 'subtitle');

    return {
      streams: {
        video: videoStreams.map((s: any) => ({
          index: s.index,
          codec_name: s.codec_name,
          codec_long_name: s.codec_long_name,
          width: s.width,
          height: s.height,
          coded_width: s.coded_width,
          coded_height: s.coded_height,
          has_b_frames: s.has_b_frames,
          sample_aspect_ratio: s.sample_aspect_ratio,
          display_aspect_ratio: s.display_aspect_ratio,
          pix_fmt: s.pix_fmt,
          level: s.level,
          color_range: s.color_range,
          color_space: s.color_space,
          color_transfer: s.color_transfer,
          color_primaries: s.color_primaries,
          chroma_location: s.chroma_location,
          field_order: s.field_order,
          r_frame_rate: s.r_frame_rate,
          avg_frame_rate: s.avg_frame_rate,
          time_base: s.time_base,
          start_pts: s.start_pts,
          start_time: s.start_time,
          duration_ts: s.duration_ts,
          duration: s.duration,
          bit_rate: s.bit_rate,
          max_bit_rate: s.max_bit_rate,
          bits_per_raw_sample: s.bits_per_raw_sample,
          nb_frames: s.nb_frames,
          tags: s.tags
        })),
        audio: audioStreams.map((s: any) => ({
          index: s.index,
          codec_name: s.codec_name,
          codec_long_name: s.codec_long_name,
          sample_fmt: s.sample_fmt,
          sample_rate: s.sample_rate,
          channels: s.channels,
          channel_layout: s.channel_layout,
          bits_per_sample: s.bits_per_sample,
          r_frame_rate: s.r_frame_rate,
          avg_frame_rate: s.avg_frame_rate,
          time_base: s.time_base,
          start_pts: s.start_pts,
          start_time: s.start_time,
          duration_ts: s.duration_ts,
          duration: s.duration,
          bit_rate: s.bit_rate,
          max_bit_rate: s.max_bit_rate,
          nb_frames: s.nb_frames,
          tags: s.tags
        })),
        subtitle: subtitleStreams.map((s: any) => ({
          index: s.index,
          codec_name: s.codec_name,
          codec_long_name: s.codec_long_name,
          time_base: s.time_base,
          start_pts: s.start_pts,
          start_time: s.start_time,
          duration_ts: s.duration_ts,
          duration: s.duration,
          tags: s.tags
        }))
      },
      format: {
        nb_streams: format.nb_streams,
        nb_programs: format.nb_programs,
        format_name: format.format_name,
        format_long_name: format.format_long_name,
        start_time: format.start_time,
        duration: format.duration,
        size: format.size,
        bit_rate: format.bit_rate,
        probe_score: format.probe_score,
        tags: format.tags
      },
      bitrate: format.bit_rate ? parseInt(format.bit_rate, 10) : null,
      sampleRate: audioStreams.length > 0 ? audioStreams[0].sample_rate : null,
      loudness: loudnessInfo,
      duration: format.duration ? parseFloat(format.duration) : null,
      keyframes: keyframes,
      hasAudio,
      hasVideo
    };
  } finally {
    await cleanupFile(inputPath);
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
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
  ], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

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
  const result = await $`ffprobe -v quiet -print_format json -show_streams ${filePath}`.quiet();
  const parsed = JSON.parse(result.stdout.toString());

  return (parsed.streams as any[]).some((s: any) => s.codec_type === "video");
}

async function checkFileHasAudioStream(filePath: string) {
  const result = await $`ffprobe -v quiet -print_format json -show_streams ${filePath}`.quiet();
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
  const audioFormats = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'opus']
  if (!videoCodec && audioFormats.includes(outputFormat)) {
    if (audioCodec && outputFormat !== audioCodec) {
      // Basic check: if output is an audio format, audio codec should ideally match or be compatible
      console.warn(`Output format ${outputFormat} and audio codec ${audioCodec} might not be a direct match.`);
    }
  }
}

async function runFFmpeg(args: string[], task: Task) {
  const command = [
    'ffmpeg',
    '-threads', '0',
    '-thread_queue_size', '256',
    ...args,
  ];
  logOperation(JSON.stringify(command));

  const proc = Bun.spawn(command, {
    stdout: 'inherit',
    stderr: 'pipe',
    timeout: 1000 * 60 * 15, // 15 minutes
  });

  await updateTask(task.id, { pid: proc.pid });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    logTask(task.id, `ffmpeg finished with exit code ${proc.exitCode} (${proc.signalCode})`);
    throw new Error(error);
  }

  const usage = proc.resourceUsage();
  if (usage) {
    console.log('Resource Usage')
    console.log(`Max memory used: ${usage.maxRSS} bytes`);
    console.log(`CPU time (user): ${usage.cpuTime.user} µs`);
    console.log(`CPU time (system): ${usage.cpuTime.system} µs`);
  }

  logTask(task.id, 'ffmpeg finished with exit code 0');
}

export function logOperation(message: string, label = 'FFmpeg') {
  console.log(`------- ${label}: ------------`);
  console.log(message);
  console.log(' ');
}
