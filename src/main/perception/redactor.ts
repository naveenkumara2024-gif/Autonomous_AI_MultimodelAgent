/**
 * Screen-content firewall (AGENTS.md section 3): the last check before any image is placed in
 * a model request. Pixel masking itself happens at capture time inside the MCP server, which
 * is where both the pixels and the UI Automation / DOM data about password fields live. This
 * module enforces that it actually happened:
 *
 *   - an image block WITHOUT the server's `_meta.redaction` record is withheld (fail closed) —
 *     an image from some path that skipped redaction must never reach the cloud;
 *   - if the user has turned screenshots off (config `allowScreenshotsToModel: false`), every
 *     image is withheld and the model gets a placeholder instead.
 *
 * Scope, deliberately stated: v1 masks PASSWORD FIELDS only. Other on-screen text (chats,
 * emails, documents) is visible to the model provider — approved in
 * prompts/stage-3-mcp-automation-agent.md decision 8.
 */

export interface RedactionRecord {
  method: string;
  scope?: string;
  masked: number;
  complete: boolean;
  error?: string;
}

export interface CandidateImage {
  mimeType: string;
  data: string;
  redaction?: RedactionRecord;
}

export interface RedactorDecision {
  allowed: CandidateImage[];
  withheld: Array<{ reason: string }>;
  notes: string[];
}

export function filterImagesForModel(images: CandidateImage[], policy: { allowScreenshotsToModel: boolean }): RedactorDecision {
  const decision: RedactorDecision = { allowed: [], withheld: [], notes: [] };
  for (const image of images) {
    if (!policy.allowScreenshotsToModel) {
      decision.withheld.push({ reason: "screenshots to the model are disabled in settings" });
      continue;
    }
    if (!image.redaction) {
      decision.withheld.push({ reason: "image has no redaction record (did not pass the capture-time firewall)" });
      continue;
    }
    if (!image.redaction.complete) {
      decision.notes.push(`password-field lookup incomplete (${image.redaction.error ?? "timed out"}); unmasked fields may be visible`);
    } else if (image.redaction.masked > 0) {
      decision.notes.push(`${image.redaction.masked} password field(s) masked`);
    }
    decision.allowed.push(image);
  }
  return decision;
}
