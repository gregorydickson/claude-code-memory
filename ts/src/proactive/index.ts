/**
 * Proactive Features barrel export.
 *
 * Port of the Python `memorygraph.proactive.__init__` module.
 * Provides AI-powered proactive features including:
 * - Session start intelligence and briefing
 * - Predictive suggestions based on current context
 * - Outcome learning and effectiveness tracking
 */

// Session briefing
export {
  generateSessionBriefing,
  getSessionBriefingResource,
  formatBriefingAsText,
  type SessionBriefing,
  type RecentActivity,
  type UnresolvedProblem,
  type RelevantPattern,
  type DeprecationWarningItem,
} from "./session-briefing.ts";

// Predictive suggestions
export {
  predictNeeds,
  warnPotentialIssues,
  suggestRelatedContext,
  type Suggestion,
  type Warning,
} from "./predictive.ts";

// Outcome learning
export {
  recordOutcome,
  updatePatternEffectiveness,
  calculateEffectivenessScore,
  designDecayMechanism,
  type Outcome,
  type EffectivenessScore,
} from "./outcome-learning.ts";
