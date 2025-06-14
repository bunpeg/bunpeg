import { z } from "zod";

// Shared param-only schemas for chaining (no 'fileId', no 'type')

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

export const TranscodeParams = z.object({
  format: videoFormat,
});

export const TranscodeSchema = TranscodeParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});

export const TranscodeSchemaWithType = TranscodeParams.extend({
  type: z.literal("transcode"),
});

export type TranscodeType = z.infer<typeof TranscodeParams>;

export const TrimParams = z.object({
  start: z.number({ required_error: "Start time is required" }),
  duration: z.number({ required_error: "Duration is required" }),
  outputFormat: videoFormat,
});

export const TrimSchema = TrimParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});

export const TrimSchemaWithType = TrimParams.extend({
  type: z.literal("trim"),
});

export type TrimType = z.infer<typeof TrimParams>;

export const CutEndParams = z.object({
  duration: z.number({ required_error: "Duration is required" }),
  outputFormat: videoFormat,
});

export const CutEndSchema = CutEndParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});

export const CutEndSchemaWithType = CutEndParams.extend({
  type: z.literal("trim-end"),
});

export type CutEndType = z.infer<typeof CutEndParams>;

export const ExtractAudioParams = z.object({
  audioFormat: audioFormat,
});

export const ExtractAudioSchema = ExtractAudioParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});

export const ExtractAudioSchemaWithType = ExtractAudioParams.extend({
  type: z.literal("extract-audio"),
});

export type ExtractAudioType = z.infer<typeof ExtractAudioParams>;

export const RemoveAudioParams = z.object({
  outputFormat: videoFormat,
})

export const RemoveAudioSchema = RemoveAudioParams.extend({
  fileId: z.string().min(1, 'fileId is required'),
});

export const RemoveAudioSchemaWithType = RemoveAudioParams.extend({
  type: z.literal('remove-audio'),
});

export type RemoveAudioType = z.infer<typeof RemoveAudioParams>;

export const MergeMediaSchema = z.object({
  fileIds: z.array(
    z.string().min(1, 'fileId is required')
  ).min(2, 'At least two files required'),
  // TODO: check if the operation can take video or audio as output, or just video
  outputFormat: z.string().min(1, 'Output format is required'),
});

export const MergeMediaSchemaWithType = MergeMediaSchema.extend({
  type: z.literal('merge-media'),
});

export type MergeMediaType = z.infer<typeof MergeMediaSchema>;

// Add audio track
export const AddAudioTrackSchema = z.object({
  videoFileId: z.string().min(1, 'videoFileId is required'),
  audioFileId: z.string().min(1, 'audioFileId is required'),
  // TODO: check if the operation can take video or audio as output, or just video
  outputFormat: z.string().min(1, 'Output format is required'),
});

export const AddAudioTrackSchemaWithType = AddAudioTrackSchema.extend({
  type: z.literal('add-audio-track'),
});

export type AddAudioTrackType = z.infer<typeof AddAudioTrackSchema>;

export const ResizeVideoParams = z.object({
  width: z.number().int().min(1, 'Width required'),
  height: z.number().int().min(1, 'Height required'),
  outputFormat: videoFormat,
});

export const ResizeVideoSchema = ResizeVideoParams.extend({
  fileId: z.string().min(1, 'fileId is required'),
});

export const ResizeVideoSchemaWithType = ResizeVideoParams.extend({
  type: z.literal('resize-video'),
});

export type ResizeVideoType = z.infer<typeof ResizeVideoParams>;

export const ExtractThumbnailParams = z.object({
  timestamp: z.string().min(1, 'Timestamp required'),
  imageFormat: imageFormat,
})

export const ExtractThumbnailSchema = ExtractThumbnailParams.extend({
  fileId: z.string().min(1, 'fileId is required'),
});

export const ExtractThumbnailSchemaWithType = ExtractThumbnailParams.extend({
  type: z.literal('extract-thumbnail'),
});

export type ExtractThumbnailType = z.infer<typeof ExtractThumbnailParams>;

// Union for chained operations

export const OperationSchema = z.union([
  TrimSchemaWithType,
  CutEndSchemaWithType,
  ExtractAudioSchemaWithType,
  TranscodeSchemaWithType,
  MergeMediaSchemaWithType,
  AddAudioTrackSchemaWithType,
  RemoveAudioSchemaWithType,
  ResizeVideoSchemaWithType,
  ExtractThumbnailSchemaWithType,
]);

export const ChainSchema = z.object({
  fileId: z.string().min(1, "fileId is required"),
  operations: z.array(OperationSchema).min(1, "At least one operation is required"),
});
export type ChainType = z.infer<typeof ChainSchema>;

export type Operations =
  | TrimType
  | CutEndType
  | ExtractAudioType
  | TranscodeType
  | MergeMediaType
  | AddAudioTrackType
  | RemoveAudioType
  | ResizeVideoType
  | ExtractThumbnailType;
