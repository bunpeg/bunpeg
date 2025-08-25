# File ID Chaining Implementation Guide

## Overview

This document provides detailed implementation instructions for adding file ID chaining functionality to the bunpeg project. File ID chaining allows tasks to reference outputs from previous tasks in a workflow, enabling complex multi-step operations like ASR processing, video pipelines, and advanced media transformations.

## Problem Statement

### Current Limitations
- Tasks can only reference static file IDs provided at creation time
- Multi-step workflows (like ASR: extract-audio → normalize → analyze → segment) cannot pass outputs between steps
- Sequential tasks must be manually coordinated with intermediate file handling
- No automatic dependency resolution between related tasks

### Required Features
- Tasks should reference outputs from previous tasks automatically
- Support for both single-input and multi-input task dependencies
- Dependency-aware task scheduling (don't start until dependencies complete)
- Clean error propagation (failed dependencies should fail dependent tasks)
- Backward compatibility with existing single-task operations

## Architecture Design

### Core Concepts

#### 1. Enhanced Task Structure
```typescript
interface Task {
  id: number;
  code: string;
  file_id: string;          // Primary input file
  operation: OperationName;
  args: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unreachable' | 'waiting_dependencies';
  pid?: number;
  error?: string;
  
  // New fields for chaining
  outputs: string[];        // File IDs this task produces
  chain_id?: string;        // Groups related tasks
}
```

#### 2. Enhanced Operation Schemas
Operations can now accept either file references or task references:

```typescript
// Base input types
const fileInput = z.object({
  file_id: z.string()
});

const taskInput = z.object({
  task_id: z.number()
});

const multiTaskInput = z.object({
  task_ids: z.array(z.number())
});

// Operations can use any of these input types
const inputSource = z.union([fileInput, taskInput, multiTaskInput]);
```

### Workflow Types

#### 1. Simple Chain (1:1 dependencies)
```
extract-audio → asr-normalize → asr-analyze → asr-segment
```

#### 2. Multi-Input Operations
```
video-file ──┐
             ├─→ add-audio → output
audio-file ──┘
```

#### 3. Fan-Out Operations
```
                 ┌─→ segment_001.wav
source-audio ────┼─→ segment_002.wav
                 └─→ manifest.json
```

## Implementation Steps

### Step 1: Database Schema Updates (`prisma/schema.prisma`)

```prisma
model tasks {
  id           Int      @id @default(autoincrement())
  code         String
  file_id      String
  pid          Int?
  operation    String   // 'transcode' | 'trim' | 'extract-audio' | 'asr-normalize' | etc
  args         String   // stringified JSON
  status       String   // 'queued' | 'processing' | 'completed' | 'failed' | 'unreachable' | 'waiting_dependencies'
  error        String?
  
  // New fields for chaining
  outputs      String[] // File IDs this task produces  
  chain_id     String?  // Groups related tasks

  @@index([file_id, status])
  @@index([chain_id])
  @@index([status])
}
```

### Step 2: Enhanced Task Management (`src/utils/tasks.ts`)

#### Updated Task Interface
```typescript
export interface Task {
  id: number;
  code: string;
  file_id: string;
  operation: OperationName;
  args: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unreachable' | 'waiting_dependencies';
  pid?: number;
  error?: string;
  outputs: string[];       // File IDs this task produces
  chain_id?: string;       // Groups related tasks
}
```

#### Enhanced Task Creation Functions
```typescript
/**
 * Create a task (dependencies are now in the args)
 */
export async function createChainTask(
  operation: Task['operation'],
  args: Operations,
  chainId?: string
) {
  const taskCode = nanoid(8);
  
  // Extract task dependencies from args
  const taskDependencies = extractTaskDependencies(args);
  const initialStatus = taskDependencies.length > 0 ? 'waiting_dependencies' : 'queued';
  
  const [task] = await sql`
    INSERT INTO tasks ${sql({
      code: taskCode,
      file_id: '', // Will be resolved from args
      status: initialStatus,
      operation,
      args: JSON.stringify(args),
      outputs: [],
      chain_id: chainId,
    })}
    RETURNING id
  `;
  
  return task.id;
}

/**
 * Extract task dependencies from operation args
 */
function extractTaskDependencies(args: any): number[] {
  const deps: number[] = [];
  
  if (args.task_id) deps.push(args.task_id);
  if (args.task_ids) deps.push(...args.task_ids);
  
  // Check for task references in nested objects
  for (const value of Object.values(args)) {
    if (typeof value === 'object' && value !== null) {
      if ('task_id' in value) deps.push(value.task_id);
      if ('task_ids' in value) deps.push(...value.task_ids);
    }
  }
  
  return deps;
}
```

/**
 * Record task output when task completes
 */
export async function recordTaskOutput(taskId: number, fileId: string) {
  // Get current outputs
  const [task] = await sql`SELECT outputs FROM tasks WHERE id = ${taskId}`;
  const currentOutputs = task.outputs || [];
  
  // Add new output
  const updatedOutputs = [...currentOutputs, fileId];
  
  await sql`UPDATE tasks SET outputs = ${updatedOutputs} WHERE id = ${taskId}`;
}

/**
 * Get task dependencies from args
 */
export async function getTaskDependencies(taskId: number): Promise<number[]> {
  const [task] = await sql`SELECT args FROM tasks WHERE id = ${taskId}`;
  const args = JSON.parse(task.args);
  return extractTaskDependencies(args);
}
```

/**
 * Get task outputs
 */
export async function getTaskOutputs(taskId: number): Promise<string[]> {
  const [task] = await sql`SELECT outputs FROM tasks WHERE id = ${taskId}`;
  return task.outputs || [];
}

/**
 * Resolve task references in args to actual file IDs
 */
export async function resolveTaskReferences(args: any): Promise<any> {
  const resolved = { ...args };
  
  // Resolve single task reference
  if (args.task_id) {
    const outputs = await getTaskOutputs(args.task_id);
    resolved.file_id = outputs[0]; // Use first output as primary file
    delete resolved.task_id;
  }
  
  // Resolve multiple task references
  if (args.task_ids) {
    const allOutputs: string[] = [];
    for (const taskId of args.task_ids) {
      const outputs = await getTaskOutputs(taskId);
      allOutputs.push(...outputs);
    }
    resolved.file_ids = allOutputs;
    delete resolved.task_ids;
  }
  
  // Resolve nested task references
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'object' && value !== null) {
      if ('task_id' in value || 'task_ids' in value) {
        resolved[key] = await resolveTaskReferences(value);
      }
    }
  }
  
  return resolved;
}
```

/**
 * Check if task dependencies are satisfied
 */
export async function areTaskDependenciesSatisfied(taskId: number): Promise<boolean> {
  const dependencies = await getTaskDependencies(taskId);
  
  if (dependencies.length === 0) return true;
  
  const [result] = await sql`
    SELECT COUNT(*) as completed_count
    FROM tasks 
    WHERE id IN ${sql(dependencies.map(id => ({ id })), 'id')}
    AND status = 'completed'
  `;
  
  return result.completed_count === dependencies.length;
}
```

/**
 * Update task status and activate dependent tasks
 */
export async function completeTaskAndActivateDependents(taskId: number) {
  // Mark task as completed
  await updateTask(taskId, { status: 'completed' });
  
  // Find tasks that depend on this one by checking their args
  const potentialDependents = await sql`
    SELECT id, args
    FROM tasks 
    WHERE status = 'waiting_dependencies'
    AND (args LIKE '%"task_id":${taskId}%' OR args LIKE '%"task_ids":%${taskId}%')
  `;

  // Check each dependent task and activate if all dependencies are satisfied
  for (const depTask of potentialDependents) {
    const dependencies = extractTaskDependencies(JSON.parse(depTask.args));
    if (dependencies.includes(taskId)) {
      const satisfied = await areTaskDependenciesSatisfied(depTask.id);
      if (satisfied) {
        await updateTask(depTask.id, { status: 'queued' });
      }
    }
  }
}
```

### Step 3: Enhanced Queue System (`src/utils/queue-ff.ts`)

#### Updated Task Selection
```typescript
export async function getNextPendingTasks(params: { excludeFileIds: string[], limit: number }) {
  const baseQuery = `
    SELECT * FROM tasks
    WHERE status = 'queued'
    AND file_id NOT IN (${params.excludeFileIds.map(() => '?').join(',')})
    ORDER BY id
    LIMIT ${params.limit}
  `;

  if (params.excludeFileIds.length === 0) {
    return await sql`SELECT * FROM tasks WHERE status = 'queued' ORDER BY id LIMIT ${params.limit}` as Task[];
  }

  return await sql`
    SELECT * FROM tasks
    WHERE status = 'queued'
    AND file_id NOT IN ${sql(params.excludeFileIds.map(id => ({ id })), 'id')}
    ORDER BY id
    LIMIT ${params.limit}
  ` as Task[];
}
```

#### Enhanced Task Processing
```typescript
async function startTask(task: Task) {
  logQueueMessage(`Picking up task: ${task.id} to ${task.operation}`);
  await updateTask(task.id, { status: 'processing' });
  activeTasks.add(task.id);
  lockedFiles.add(task.file_id);

  const { error: operationError } = await tryCatch(runOperationWithDependencies(task));

  if (operationError) {
    await updateTask(task.id, { status: "failed", error: operationError.message });
    await markDependentTasksAsUnreachable(task.id);
    await markPendingTasksForFileAsUnreachable(task.file_id);
    logQueueError(`Failed to process task: ${task.id}`, operationError);
  } else {
    // Complete task and activate dependents
    await completeTaskAndActivateDependents(task.id);
  }

  activeTasks.delete(task.id);
  lockedFiles.delete(task.file_id);

  if (shouldRun) {
    void executePass();
  }
}

/**
 * Run operation with task reference resolution
 */
async function runOperationWithDependencies(task: Task) {
  // Resolve task references in args to actual file IDs
  const originalArgs = JSON.parse(task.args);
  const resolvedArgs = await resolveTaskReferences(originalArgs);
  
  // Update task with resolved args
  const taskWithResolvedArgs = {
    ...task,
    args: JSON.stringify(resolvedArgs)
  };
  
  // Run the operation with resolved references
  const result = await runOperation(taskWithResolvedArgs);
  
  // Record output if operation was successful and produced a new file
  if (result && typeof result === 'object' && 'outputFileId' in result) {
    await recordTaskOutput(task.id, result.outputFileId as string);
  }
  
  return result;
}
```

// Removed - no longer needed with simplified approach

/**
 * Mark dependent tasks as unreachable when a dependency fails
 */
async function markDependentTasksAsUnreachable(failedTaskId: number) {
  // Find all tasks that depend on the failed task
  const dependentTasks = await sql`
    SELECT id, args
    FROM tasks 
    WHERE status IN ('queued', 'waiting_dependencies')
    AND (args LIKE '%"task_id":${failedTaskId}%' OR args LIKE '%"task_ids":%${failedTaskId}%')
  `;
  
  // Mark each dependent task as unreachable
  for (const task of dependentTasks) {
    const dependencies = extractTaskDependencies(JSON.parse(task.args));
    if (dependencies.includes(failedTaskId)) {
      await updateTask(task.id, { status: 'unreachable' });
    }
  }
}
```

### Step 4: Enhanced S3 Operations (`src/utils/s3.ts`)

#### Support Multiple Outputs
```typescript
export interface S3OperationResult {
  success: boolean;
  outputs?: Record<string, string>;  // role -> file_id mapping
}

/**
 * Enhanced S3 operation handler that supports multiple outputs
 */
export async function handleS3OperationWithOutputs(params: {
  task: Task;
  outputFiles: Array<{ role: string; filename: string }>;
  fileIds: string[];
  parentFile?: string;
  operation: (ctx: { inputPaths: string[]; outputPaths: Record<string, string> }) => Promise<any>;
}): Promise<S3OperationResult> {
  const { task, outputFiles, fileIds, parentFile, operation } = params;

  // Download input files
  const inputPaths: string[] = [];
  const s3Paths: string[] = [];

  for (const fileId of fileIds) {
    const file = await getFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    const localPath = await downloadFromS3ToDisk(file);
    inputPaths.push(localPath);
    s3Paths.push(file.file_path);
  }

  // Prepare output paths
  const outputPaths: Record<string, string> = {};
  const tempDir = path.join(TEMP_DIR, task.code);
  await mkdir(tempDir, { recursive: true });

  for (const output of outputFiles) {
    outputPaths[output.role] = path.join(tempDir, output.filename);
  }

  try {
    // Execute operation
    const result = await operation({ inputPaths, outputPaths });

    // Upload outputs and create file records
    const outputs: Record<string, string> = {};

    for (const output of outputFiles) {
      const localPath = outputPaths[output.role];
      const fileExists = await Bun.file(localPath).exists();

      if (fileExists) {
        const newFileId = extractFileName(output.filename);
        const s3Key = `${newFileId}/${output.filename}`;

        // Upload to S3
        await uploadToS3FromDisk(localPath, s3Key);

        // Create file record
        await createFile({
          id: newFileId,
          file_name: output.filename,
          file_path: s3Key,
          mime_type: getMimeType(output.filename),
          parent: parentFile,
        });

        outputs[output.role] = newFileId;
      }
    }

    return { success: true, outputs };

  } finally {
    // Cleanup
    for (const inputPath of inputPaths) {
      await cleanupFile(inputPath);
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}
```

### Step 5: Enhanced Operation Schemas (`src/utils/schemas.ts`)

Add support for task references in operation schemas:

```typescript
// Base input union for file or task references
const inputSource = z.union([
  z.object({ file_id: fileId }),
  z.object({ task_id: z.number().int().positive() }),
  z.object({ task_ids: z.array(z.number().int().positive()).min(1) })
]);

// Update existing schemas to support task references
export const AsrNormalizeSchema = z.object({
  ...inputSource.shape, // file_id, task_id, or task_ids
  mode: mode.default('append'),
  parent: parentId,
});

export const AsrAnalyzeSchema = z.object({
  ...inputSource.shape, // file_id, task_id, or task_ids
  max_segment_duration: z.number(),
  min_segment_duration: z.number(), 
  silence_threshold: z.string(),
  silence_duration: z.number(),
  mode: mode.default('append'),
  parent: parentId,
});

export const AsrSegmentSchema = z.object({
  task_ids: z.array(z.number().int().positive()).length(2), // Requires exactly 2 tasks: [normalize_task, analyze_task]
  mode: mode.default('append'), 
  parent: parentId,
});
```

### Step 6: Simplified Chain Builder (`src/utils/chain-builder.ts`)

```typescript
import { nanoid } from 'nanoid';
import { createChainTask } from './tasks.ts';
import type { Operations, OperationName } from './schemas.ts';

export class TaskChainBuilder {
  private chainId: string;
  private tasks: Array<{
    operation: OperationName;
    args: Operations;
  }> = [];

  constructor(chainId?: string) {
    this.chainId = chainId || `chain_${nanoid(8)}`;
  }

  /**
   * Add a task to the chain
   */
  addTask(operation: OperationName, args: Operations): number {
    const taskIndex = this.tasks.length;
    this.tasks.push({ operation, args });
    return taskIndex;
  }

  /**
   * Build and create all tasks in the database
   */
  async build(): Promise<number[]> {
    const createdTaskIds: number[] = [];
    
    // Create tasks in order
    for (const taskDef of this.tasks) {
      const taskId = await createChainTask(
        taskDef.operation,
        taskDef.args,
        this.chainId
      );
      
      createdTaskIds.push(taskId);
    }
    
    return createdTaskIds;
  }
}
```

## Usage Examples

### Simple ASR Chain
```typescript
const builder = new TaskChainBuilder();

// Task 0: extract-audio (for video files)  
const extractTaskId = builder.addTask('extract-audio', {
  file_id: originalFileId,
  audio_format: 'wav',
  mode: 'append',
  parent: parentId
});

// Task 1: asr-normalize (uses output from extract-audio task)
const normalizeTaskId = builder.addTask('asr-normalize', {
  task_id: extractTaskId, // Explicit reference to extract-audio task
  mode: 'append', 
  parent: parentId
});

// Task 2: asr-analyze (uses output from normalize task)
const analyzeTaskId = builder.addTask('asr-analyze', {
  task_id: normalizeTaskId, // Explicit reference to normalize task
  max_segment_duration: 120,
  min_segment_duration: 30,
  silence_threshold: '-40dB',
  silence_duration: 0.5,
  mode: 'append',
  parent: parentId
});

// Task 3: asr-segment (uses outputs from both normalize and analyze tasks) 
builder.addTask('asr-segment', {
  task_ids: [normalizeTaskId, analyzeTaskId], // Explicit references to both tasks
  mode: 'append',
  parent: parentId
});

// Create all tasks (no parameters needed)
const taskIds = await builder.build();
```

### API Integration
```typescript
// Updated /asr endpoint
"/asr": {
  POST: async (req) => {
    const body = await req.json();
    const parsed = AsrSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: parsed.error }, { status: 400, headers: CORS_HEADERS });
    }

    const args = parsed.data;
    const builder = new TaskChainBuilder();

    // Check if input is video file
    const file = await getFile(args.file_id);
    const filePath = await downloadFromS3ToDisk(file);
    const hasVideo = await checkFileHasVideoStream(filePath);
    await cleanupFile(filePath);

    let currentTaskIndex = -1;

    let inputTaskId: number | undefined;
    
    if (hasVideo) {
      // Add extract-audio task for video files
      inputTaskId = builder.addTask('extract-audio', {
        file_id: args.file_id,
        audio_format: 'wav', 
        mode: 'append',
        parent: args.parent,
      });
    }
    
    // Add ASR tasks with explicit task references
    const normalizeTask = builder.addTask('asr-normalize', {
      ...(inputTaskId ? { task_id: inputTaskId } : { file_id: args.file_id }),
      mode: 'append',
      parent: args.parent,
    });
    
    const analyzeTask = builder.addTask('asr-analyze', {
      task_id: normalizeTask, // Explicit reference to normalize task
      max_segment_duration: args.max_segment_duration,
      min_segment_duration: args.min_segment_duration,
      silence_threshold: args.silence_threshold,
      silence_duration: args.silence_duration,
      mode: 'append',
      parent: args.parent,
    });
    
    builder.addTask('asr-segment', {
      task_ids: [normalizeTask, analyzeTask], // Explicit references to both tasks
      mode: 'append',
      parent: args.parent,
    });
    
    // Create the task chain
    const taskIds = await builder.build();

    return Response.json({
      success: true,
      chainId: builder.chainId,
      taskIds
    }, { headers: CORS_HEADERS });
  }
}
```

## Migration Strategy

### Phase 1: Core Infrastructure
1. Add database tables for dependencies and outputs
2. Implement enhanced task management functions
3. Update queue system to handle dependency resolution

### Phase 2: Enhanced Operations
1. Update existing operations to support multiple outputs
2. Implement chain builder utility
3. Add dependency placeholder resolution

### Phase 3: API Integration
1. Update ASR endpoint to use chaining
2. Add chain monitoring endpoints
3. Implement chain cleanup utilities

### Backward Compatibility
- Existing single-task operations continue to work unchanged
- New chaining features are opt-in
- Legacy task structure remains supported

## Benefits

✅ **Powerful Workflows** - Support complex multi-step operations
✅ **Automatic Dependency Management** - Tasks wait for dependencies automatically
✅ **Error Propagation** - Failed dependencies properly fail dependent tasks
✅ **Resource Efficiency** - No unnecessary polling or manual coordination
✅ **Scalable Architecture** - Supports both simple and complex workflows
✅ **Clean Abstractions** - Chain builder provides intuitive API

## Implementation Notes

### Performance Considerations
- Dependency checking adds database queries but improves workflow reliability
- Task outputs table should be indexed properly for performance
- Consider cleanup policies for completed chains

### Error Handling
- Failed dependencies mark all dependent tasks as unreachable
- Chain-level error reporting for better debugging
- Proper cleanup of partial results on failures

### Monitoring
- Chain progress tracking via task status aggregation
- Dependencies visualization for debugging
- Performance metrics for chain execution times

This file ID chaining system provides a solid foundation for complex workflows like ASR while maintaining backward compatibility with existing simple operations.
