/**
 * Claude Code Integration module for automatic context capture and project awareness.
 *
 * Port of the Python `memorygraph.integration.__init__` module.
 *
 * This module provides deep integration with Claude Code development workflows:
 * - Development context capture (tasks, commands, errors)
 * - Project-aware memory (codebase analysis, file tracking)
 * - Workflow memory tools (tracking, suggestions, optimization)
 */

// Context Capture
export type { TaskContext, CommandExecution, ErrorPattern } from "./context-capture.ts";
export {
  captureTaskContext,
  captureCommandExecution,
  analyzeErrorPatterns,
  trackSolutionEffectiveness,
} from "./context-capture.ts";

// Project Analysis
export type { ProjectInfo, CodebaseInfo, FileChange, Pattern } from "./project-analysis.ts";
export {
  detectProject,
  analyzeCodebase,
  trackFileChanges,
  identifyCodePatterns,
} from "./project-analysis.ts";

// Workflow Tracking
export type {
  WorkflowAction,
  WorkflowSuggestion,
  Recommendation,
  SessionState,
} from "./workflow-tracking.ts";
export {
  trackWorkflow,
  suggestWorkflow,
  optimizeWorkflow,
  getSessionState,
} from "./workflow-tracking.ts";
