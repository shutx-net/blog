import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { PLACEHOLDER_SITE_URL, resolveSiteUrl } from "../../src/site-url.ts";

// Pins the one value that decides what every canonical link, sitemap entry and --
// the part that cannot be taken back -- every RSS <guid isPermaLink="true"> says in
// production. The failure this guards is silent: if SITE_URL is missing from the
// deploy workflow, resolveSiteUrl returns the placeholder, `astro build` exits 0,
// and the feed ships `https://blog.invalid/` guids to real subscribers.
//
// This test lives in site/ rather than infra/ on purpose. The rules for a valid
// SITE_URL exist in exactly one place -- src/site-url.ts -- so the assertions run
// the real resolveSiteUrl instead of restating "starts with https, is not
// .invalid" in a second place that could drift from the first. It also keeps the
// dependency direction one-way: infra does not import site.

interface WorkflowStep {
  name?: unknown;
  uses?: unknown;
  run?: unknown;
  env?: Record<string, unknown>;
}

interface WorkflowJob {
  env?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

interface Workflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

const workflowPath = (name: string): string =>
  fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url));

// Asserting existence first keeps a missing file from surfacing as "the YAML is
// broken", which sends you looking in the wrong place.
const loadWorkflow = (name: string): Workflow => {
  const path = workflowPath(name);
  expect(existsSync(path), `${path} exists`).toBe(true);
  return parse(readFileSync(path, "utf8")) as Workflow;
};

const rawWorkflow = (name: string): string => {
  const path = workflowPath(name);
  expect(existsSync(path), `${path} exists`).toBe(true);
  return readFileSync(path, "utf8");
};

const BUILD_COMMAND = "npm run -w site build";

const allSteps = (workflow: Workflow): WorkflowStep[] => {
  const jobs = Object.values(workflow.jobs ?? {});
  expect(jobs.length, "deploy.yml has at least one job").toBeGreaterThan(0);
  return jobs.flatMap((job) => job.steps ?? []);
};

/** The single step that builds the site. Exactly one, so the env below is unambiguous. */
const buildStep = (): WorkflowStep => {
  const steps = allSteps(loadWorkflow("deploy.yml")).filter(
    (step) => typeof step.run === "string" && step.run.includes(BUILD_COMMAND),
  );
  expect(steps.length, `exactly one step runs \`${BUILD_COMMAND}\``).toBe(1);
  return steps[0] as WorkflowStep;
};

const siteUrlInYaml = (): string => {
  const value = buildStep().env?.["SITE_URL"];
  expect(typeof value, "the build step sets env.SITE_URL").toBe("string");
  return value as string;
};

describe("deploy.yml pins SITE_URL for the production build", () => {
  it("has exactly one step running the site build", () => {
    expect(typeof buildStep().run).toBe("string");
  });

  it("gives that step a non-blank SITE_URL", () => {
    const value = siteUrlInYaml();
    expect(value.trim().length, "SITE_URL must not be blank").toBeGreaterThan(0);
  });

  it("sets a SITE_URL that resolveSiteUrl accepts", () => {
    // Runs the real rule rather than restating it: absolute, and https.
    expect(() => resolveSiteUrl({ SITE_URL: siteUrlInYaml() })).not.toThrow();
  });

  // This is the assertion that closes the failure mode this whole file exists for.
  it("does not resolve to the placeholder", () => {
    expect(resolveSiteUrl({ SITE_URL: siteUrlInYaml() })).not.toBe(PLACEHOLDER_SITE_URL);
  });

  it("does not point at any .invalid host", () => {
    // Overlaps the previous assertion but is wider: it also rejects a *different*
    // .invalid host, which would resolve to something that is not the placeholder
    // and would otherwise slip through.
    const host = new URL(resolveSiteUrl({ SITE_URL: siteUrlInYaml() })).hostname;
    expect(host.endsWith(".invalid"), `SITE_URL host is ${host}`).toBe(false);
  });

  it("is already written in normalised form in the YAML", () => {
    // resolveSiteUrl silently drops any path, query and fragment. Requiring the
    // YAML to hold the normalised value (origin + trailing slash) means the file
    // cannot claim to publish under a path that the build would quietly discard.
    expect(resolveSiteUrl({ SITE_URL: siteUrlInYaml() })).toBe(siteUrlInYaml());
  });

  it("scopes SITE_URL to the build step, not the workflow or the job", () => {
    // Leaking it wider would silently break a test-running step added later, the
    // same way setting it in ci.yml breaks site-url.test.ts today.
    const workflow = loadWorkflow("deploy.yml");
    expect(Object.keys(workflow.env ?? {})).not.toContain("SITE_URL");
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      expect(Object.keys(job.env ?? {}), `job ${name} env`).not.toContain("SITE_URL");
    }
  });

  it("never sets SITE_URL in ci.yml", () => {
    // site-url.test.ts asserts `process.env.SITE_URL ?? "" === ""` as a
    // precondition, so setting SITE_URL in CI would fail the site suite. These two
    // tests guard opposite sides of the same convention.
    expect(rawWorkflow("ci.yml")).not.toContain("SITE_URL");
  });
});
