import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export interface ProjectTrustState {
  workspaceRoot: string;
  projectKey: string;
  trusted: boolean;
  storePath: string;
  updatedAt?: string;
}

interface ProjectTrustRecord {
  workspaceRoot: string;
  trusted: boolean;
  updatedAt: string;
}

interface ProjectTrustStoreFile {
  version: 1;
  projects: Record<string, ProjectTrustRecord>;
}

const ProjectTrustRecordSchema = z
  .object({
    workspaceRoot: z.string(),
    trusted: z.boolean(),
    updatedAt: z.string()
  })
  .strict();

const ProjectTrustStoreFileSchema: z.ZodType<ProjectTrustStoreFile> = z
  .object({
    version: z.literal(1),
    projects: z.record(ProjectTrustRecordSchema)
  })
  .strict();

export function getProjectTrustStorePath(userAlyceDirectory = path.join(os.homedir(), ".alyce")) {
  return path.join(userAlyceDirectory, "trusted-projects.json");
}

export function getUserHomeFromAlyceDirectory(userAlyceDirectory: string) {
  return path.basename(path.resolve(userAlyceDirectory)) === ".alyce"
    ? path.dirname(path.resolve(userAlyceDirectory))
    : path.resolve(userAlyceDirectory);
}

export function normalizeTrustedWorkspaceRoot(workspaceRoot: string) {
  const resolved = path.resolve(workspaceRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function getProjectTrustKey(workspaceRoot: string) {
  return createHash("sha256")
    .update(normalizeTrustedWorkspaceRoot(workspaceRoot))
    .digest("hex");
}

export async function getProjectTrustState(
  workspaceRoot: string,
  options: { userAlyceDirectory?: string } = {}
): Promise<ProjectTrustState> {
  const storePath = getProjectTrustStorePath(options.userAlyceDirectory);
  const projectKey = getProjectTrustKey(workspaceRoot);
  const store = await readTrustStore(storePath);
  const record = store.projects[projectKey];

  return {
    workspaceRoot: path.resolve(workspaceRoot),
    projectKey,
    storePath,
    trusted: record?.trusted === true,
    ...(record?.updatedAt ? { updatedAt: record.updatedAt } : {})
  };
}

export async function setProjectTrusted(
  workspaceRoot: string,
  trusted: boolean,
  options: { userAlyceDirectory?: string; now?: Date } = {}
): Promise<ProjectTrustState> {
  const storePath = getProjectTrustStorePath(options.userAlyceDirectory);
  const projectKey = getProjectTrustKey(workspaceRoot);
  const store = await readTrustStore(storePath);
  const updatedAt = (options.now ?? new Date()).toISOString();
  store.projects[projectKey] = {
    workspaceRoot: path.resolve(workspaceRoot),
    trusted,
    updatedAt
  };

  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

  return {
    workspaceRoot: path.resolve(workspaceRoot),
    projectKey,
    storePath,
    trusted,
    updatedAt
  };
}

async function readTrustStore(storePath: string): Promise<ProjectTrustStoreFile> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return ProjectTrustStoreFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        version: 1,
        projects: {}
      };
    }

    if (error instanceof z.ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid project trust store ${storePath}: ${details}`);
    }

    throw error;
  }
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
