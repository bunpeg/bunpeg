import { z } from "zod";

export const videoFormat = z.enum([
  "mp4",
  "mkv",
  "webm",
  "mov",
  "avi",
]);
export type VideoFormat = z.infer<typeof videoFormat>;

export const audioFormat = z.enum([
  "mp3",
  "m4a",
  "aac",
  "flac",
  "wav",
  "opus",
]);
export type AudioFormat = z.infer<typeof audioFormat>;

export const imageFormat = z.enum([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "svg",
]);
export type ImageFormat = z.infer<typeof imageFormat>;

export const videoCodec = z.enum([
  "h264",
  "hevc",
  "vp9",
  "av1",
]);
export type VideoCodec = z.infer<typeof videoCodec>;

export const audioCodec = z.enum([
  "aac",
  "mp3",
  "ac3",
  "opus",
  "flac",
]);
export type AudioCodec = z.infer<typeof audioCodec>;

const fileId = z.string().min(1, "fileId is required");
const parentId = z.string().min(1, "parentId is required").optional();
const mode = z.enum(['append', 'replace']).default('replace');

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
export const TranscodeSchema = TranscodeParams.extend({ file_id: fileId });
export type TranscodeType = z.infer<typeof TranscodeSchema>;

const ResizeVideoParams = z.object({
  width: z.number().int().min(-2, 'Width must be positive or -1/-2 for auto-scaling'),
  height: z.number().int().min(-2, 'Height must be positive or -1/-2 for auto-scaling'),
  output_format: videoFormat,
  parent: parentId,
  mode,
});
export const ResizeVideoSchema = ResizeVideoParams.extend({ file_id: fileId });
export type ResizeVideoType = z.infer<typeof ResizeVideoSchema>;

const TrimParams = z.object({
  start: z.number({ required_error: "Start time is required" }),
  duration: z.number({ required_error: "Duration is required" }),
  output_format: videoFormat,
  exact: z.boolean().default(false),
  parent: parentId,
  mode,
});
export const TrimSchema = TrimParams.extend({ file_id: fileId });
export type TrimType = z.infer<typeof TrimSchema>;

const CutEndParams = z.object({
  duration: z.number({ required_error: "Duration is required" }),
  output_format: videoFormat,
  parent: parentId,
  mode,
});
export const CutEndSchema = CutEndParams.extend({ file_id: fileId });
export type CutEndType = z.infer<typeof CutEndSchema>;

const ExtractAudioParams = z.object({
  audio_format: audioFormat,
  audio_codec: audioCodec.optional(),
  parent: parentId,
  mode,
});
export const ExtractAudioSchema = ExtractAudioParams.extend({ file_id: fileId });
export type ExtractAudioType = z.infer<typeof ExtractAudioSchema>;

const RemoveAudioParams = z.object({
  output_format: videoFormat,
  parent: parentId,
  mode,
})
export const RemoveAudioSchema = RemoveAudioParams.extend({ file_id: fileId });
export type RemoveAudioType = z.infer<typeof RemoveAudioSchema>;

export const AddAudioTrackSchema = z.object({
  video_file_id: fileId,
  audio_file_id: fileId,
  output_format: videoFormat,
  video_codec: videoCodec.optional(),
  audio_codec: audioCodec.optional(),
  mode: mode.default('append'),
  parent: parentId,
});
export type AddAudioTrackType = z.infer<typeof AddAudioTrackSchema>;

export const MergeMediaSchema = z.object({
  file_ids: z.array(fileId).min(2, 'At least two files required'),
  // TODO: check if the operation can take video or audio as output, or just video
  output_format: z.string().min(1, 'Output format is required'),
  mode: mode.default('append'),
  parent: parentId,
});
export type MergeMediaType = z.infer<typeof MergeMediaSchema>;

export const ExtractThumbnailParams = z.object({
  timestamp: z.string().min(1, 'Timestamp required'),
  image_format: imageFormat,
  mode,
  parent: parentId,
})
export const ExtractThumbnailSchema = ExtractThumbnailParams.extend({ file_id: fileId });
export type ExtractThumbnailType = z.infer<typeof ExtractThumbnailSchema>;

// ASR (Speech-to-Text Preparation) schemas
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
  parent: parentId,
});
export type AsrNormalizeType = z.infer<typeof AsrNormalizeSchema>;

export const AsrAnalyzeSchema = z.object({
  file_id: fileId,
  max_segment_duration: z.number(),
  min_segment_duration: z.number(),
  silence_threshold: z.string(),
  silence_duration: z.number(),
  parent: parentId,
});
export type AsrAnalyzeType = z.infer<typeof AsrAnalyzeSchema>;

export const AsrSegmentSchema = z.object({
  file_id: fileId,
  parent: parentId,
});
export type AsrSegmentType = z.infer<typeof AsrSegmentSchema>;

// Vision Chunks schemas
export const VisionParams = z.object({
  scene_threshold: z.number().min(0).max(1).default(0.4),
  parent: parentId,
});

export const VisionSchema = VisionParams.extend({ file_id: fileId });
export type VisionType = z.infer<typeof VisionSchema>;

// Internal Vision operation schemas (NOT exposed to users)
export const VisionAnalyzeSchema = z.object({
  file_id: fileId,
  scene_threshold: z.number().min(0).max(1),
  parent: parentId,
});
export type VisionAnalyzeType = z.infer<typeof VisionAnalyzeSchema>;

export const VisionSegmentSchema = z.object({
  file_id: fileId,
  parent: parentId,
});
export type VisionSegmentType = z.infer<typeof VisionSegmentSchema>;

// Union for chained operation
export const ChainOperationSchema = z.union([
  TrimParams.extend({ type: z.literal("trim") }),
  CutEndParams.extend({ type: z.literal("trim-end") }),
  ExtractAudioParams.extend({ type: z.literal("extract-audio") }),
  TranscodeParams.extend({ type: z.literal("transcode") }),
  RemoveAudioParams.extend({ type: z.literal('remove-audio') }),
  ResizeVideoParams.extend({ type: z.literal('resize-video') }),
  ExtractThumbnailParams.extend({ type: z.literal('extract-thumbnail') }),
]);

export const ChainSchema = z.object({
  file_id: fileId,
  operations: z.array(ChainOperationSchema).min(1, "At least one operation is required"),
});
type ChainType = z.infer<typeof ChainSchema>;

export const BulkSchema = z.object({
  file_ids: z.array(fileId).min(1, "At least one operation is required"),
  operation: ChainOperationSchema,
})

export const DashSchema = z.object({ file_id: fileId });
export type DashType = z.infer<typeof DashSchema>;

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
  | AsrSegmentType
  | VisionAnalyzeType
  | VisionSegmentType;

export type OperationName = ChainType['operations'][number]['type'] | 'add-audio' | 'merge-media' | 'dash' | 'asr-normalize' | 'asr-analyze' | 'asr-segment' | 'vision-analyze' | 'vision-segment';
