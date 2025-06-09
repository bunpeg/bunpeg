import { z } from "zod";

// Shared param-only schemas for chaining (no 'fileId', no 'type')

const TrimParams = z.object({
  start: z.number({ required_error: "Start time is required" }),
  duration: z.number({ required_error: "Duration is required" }),
  outputFormat: z.string().min(1, "Output format is required"),
});

const CutEndParams = z.object({
  duration: z.number({ required_error: "Duration is required" }),
  outputFormat: z.string().min(1, "Output format is required"),
});

const ExtractAudioParams = z.object({
  audioFormat: z.string(),
});

const TranscodeParams = z.object({
  format: z.string().min(1, "Format is required"),
});

// Individual operation schemas (for single-operation endpoints), includes fileId

export const TrimSchema = TrimParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});
export type TrimOperation = z.infer<typeof TrimSchema>;

export const CutEndSchema = CutEndParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});
export type CutEndOperation = z.infer<typeof CutEndSchema>;

export const ExtractAudioSchema = ExtractAudioParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});
export type ExtractAudioOperation = z.infer<typeof ExtractAudioSchema>;

export const TranscodeSchema = TranscodeParams.extend({
  fileId: z.string().min(1, "fileId is required"),
});
export type TranscodeOperation = z.infer<typeof TranscodeSchema>;

// Chained operation variant schemas (for /chain endpoint), includes type and no fileId

export const TrimSchemaWithType = TrimParams.extend({
  type: z.literal("trim"),
});

export const CutEndSchemaWithType = CutEndParams.extend({
  type: z.literal("trim-end"),
});

export const ExtractAudioSchemaWithType = ExtractAudioParams.extend({
  type: z.literal("extract-audio"),
});

export const TranscodeSchemaWithType = TranscodeParams.extend({
  type: z.literal("transcode"),
});

// Merge media
export const MergeMediaSchema = z.object({
  fileIds: z.array(z.string().min(1, 'fileId is required')).min(2, 'At least two files required'),
  outputFormat: z.string().min(1, 'Output format is required'),
});
export type MergeMediaOperation = z.infer<typeof MergeMediaSchema>;

export const MergeMediaSchemaWithType = MergeMediaSchema.extend({
  type: z.literal('merge-media'),
});

// Add audio track
export const AddAudioTrackSchema = z.object({
  videoFileId: z.string().min(1, 'videoFileId is required'),
  audioFileId: z.string().min(1, 'audioFileId is required'),
  outputFormat: z.string().min(1, 'Output format is required'),
});
export type AddAudioTrackOperation = z.infer<typeof AddAudioTrackSchema>;

export const AddAudioTrackSchemaWithType = AddAudioTrackSchema.extend({
  type: z.literal('add-audio-track'),
});

// Remove audio
export const RemoveAudioSchema = z.object({
  fileId: z.string().min(1, 'fileId is required'),
  outputFormat: z.string().min(1, 'Output format is required'),
});
export type RemoveAudioOperation = z.infer<typeof RemoveAudioSchema>;

export const RemoveAudioSchemaWithType = RemoveAudioSchema.extend({
  type: z.literal('remove-audio'),
});

// Resize video
export const ResizeVideoSchema = z.object({
  fileId: z.string().min(1, 'fileId is required'),
  width: z.number().int().min(1, 'Width required'),
  height: z.number().int().min(1, 'Height required'),
  outputFormat: z.string().min(1, 'Output format is required'),
});
export type ResizeVideoOperation = z.infer<typeof ResizeVideoSchema>;

export const ResizeVideoSchemaWithType = ResizeVideoSchema.extend({
  type: z.literal('resize-video'),
});

// Extract thumbnail
export const ExtractThumbnailSchema = z.object({
  fileId: z.string().min(1, 'fileId is required'),
  timestamp: z.string().min(1, 'Timestamp required'),
  imageFormat: z.string().min(1, 'Image format required'),
});
export type ExtractThumbnailOperation = z.infer<typeof ExtractThumbnailSchema>;

export const ExtractThumbnailSchemaWithType = ExtractThumbnailSchema.extend({
  type: z.literal('extract-thumbnail'),
});

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
  | z.infer<typeof TrimParams>
  | z.infer<typeof CutEndParams>
  | z.infer<typeof ExtractAudioParams>
  | z.infer<typeof TranscodeParams>
  | MergeMediaOperation
  | AddAudioTrackOperation
  | RemoveAudioOperation
  | ResizeVideoOperation
  | ExtractThumbnailOperation;
