import { describe, expect, it } from "vitest";
import { isResumeTrigger, resumeTarget } from "../src/lib/resume.js";

const url = "https://login.carrier.example.invalid/resume";

describe("resumeTarget", () => {
  it("resumes while under the limit", () => {
    expect(resumeTarget({ resumeUrl: url, resumes: 0, done: false })).toBe(url);
    expect(resumeTarget({ resumeUrl: url, resumes: 2, done: false })).toBe(url);
  });
  it("stops after three resumes", () => {
    expect(resumeTarget({ resumeUrl: url, resumes: 3, done: false })).toBeNull();
  });
  it("never resumes without resumeUrl or after a capture", () => {
    expect(resumeTarget({ resumeUrl: null, resumes: 0, done: false })).toBeNull();
    expect(resumeTarget({ resumeUrl: url, resumes: 0, done: true })).toBeNull();
  });
});

describe("isResumeTrigger", () => {
  it("only main-frame POSTs arm the timer", () => {
    expect(isResumeTrigger({ method: "POST", type: "main_frame" })).toBe(true);
    expect(isResumeTrigger({ method: "post", type: "main_frame" })).toBe(true);
    expect(isResumeTrigger({ method: "GET", type: "main_frame" })).toBe(false);
    expect(isResumeTrigger({ method: "POST", type: "xmlhttprequest" })).toBe(false);
  });
});
