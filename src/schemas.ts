import { z } from "zod";

// 🔁 Shared param-only schemas for chaining (no 'fileId', no 'type')
const TrimParams = z.object({
  start: z.string().min(1, "Start time is required"),
  duration: z.string().min(1, "Duration is required"),
  outputFormat: z.string().min(1, "Output format is required"),
});

const CutEndParams = z.object({
  duration: z.string().min(1, "Duration is required"),
  outputFormat: z.string().min(1, "Output format is required"),
});

const ExtractAudioParams = z.object({
  audioFormat: z.string(),
});

const TranscodeParams = z.object({
  format: z.string().min(1, "Format is required"),
});

// 🟢 Individual operation schemas (for single-operation endpoints)
// Includes fileId
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

// 🔁 Chained operation variant schemas (for /chain endpoint)
// Includes type, no fileId
export const TrimSchemaWithType = TrimParams.extend({
  type: z.literal("trim"),
});

export const CutEndSchemaWithType = CutEndParams.extend({
  type: z.literal("cut-end"),
});

export const ExtractAudioSchemaWithType = ExtractAudioParams.extend({
  type: z.literal("extract-audio"),
});

export const TranscodeSchemaWithType = TranscodeParams.extend({
  type: z.literal("transcode"),
});

// 🔁 Union for chained operations
export const OperationSchema = z.union([
  TrimSchemaWithType,
  CutEndSchemaWithType,
  ExtractAudioSchemaWithType,
  TranscodeSchemaWithType,
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
  | z.infer<typeof TranscodeParams>;
