import { MAX_RESUMES } from "./protocol.js";

export interface ResumeState {
  resumeUrl: string | null;
  resumes: number;
}

/**
 * Rule 5: called RESUME_DELAY_MS after a main-frame POST in the watched tab completed.
 * Returns the address to navigate to, or null when nothing should happen.
 */
export function resumeTarget(state: ResumeState): string | null {
  if (state.resumeUrl === null) return null;
  if (state.resumes >= MAX_RESUMES) return null;
  return state.resumeUrl;
}

/** Whether a completed webRequest should arm the resume timer. */
export function isResumeTrigger(details: { method: string; type: string }): boolean {
  return details.method.toUpperCase() === "POST" && details.type === "main_frame";
}
