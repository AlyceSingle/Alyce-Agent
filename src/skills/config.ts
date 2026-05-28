import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { SkillConfigTarget } from "./types.js";

export interface SkillSettingsPaths {
  projectPath: string;
  userPath: string;
}

export interface SkillSettingsLayer {
  disabledSkillIds: string[];
  disabledSkillNames: string[];
  disabledSkillPaths: string[];
  disableBundledSkills: boolean;
}

export interface SkillSettingsState {
  project: SkillSettingsLayer;
  user: SkillSettingsLayer;
  effective: SkillSettingsLayer;
  projectPath: string;
  userPath: string;
}

const SkillSettingsFileSchema = z.object({
  disabledSkillIds: z.array(z.string()).optional(),
  disabledSkillNames: z.array(z.string()).optional(),
  disabledSkillPaths: z.array(z.string()).optional(),
  disableBundledSkills: z.boolean().optional()
}).strict();

export function getSkillSettingsPaths(
  workspaceRoot: string,
  userHomeDirectory = os.homedir()
): SkillSettingsPaths {
  return {
    projectPath: path.join(workspaceRoot, ".alyce", "skills.json"),
    userPath: path.join(userHomeDirectory, ".alyce", "skills.json")
  };
}

export async function loadSkillSettings(
  paths: SkillSettingsPaths,
  options: { trustedProject?: boolean } = {}
): Promise<SkillSettingsState> {
  const trustedProject = options.trustedProject !== false;
  const [projectRaw, userRaw] = await Promise.all([
    trustedProject ? readSkillSettingsFile(paths.projectPath) : Promise.resolve({}),
    readSkillSettingsFile(paths.userPath)
  ]);
  const project = normalizeSkillSettingsLayer(projectRaw);
  const user = normalizeSkillSettingsLayer(userRaw);

  return {
    project,
    user,
    effective: {
      disabledSkillIds: uniqueSorted([
        ...project.disabledSkillIds,
        ...user.disabledSkillIds
      ]),
      disabledSkillNames: uniqueSorted([
        ...project.disabledSkillNames,
        ...user.disabledSkillNames
      ]),
      disabledSkillPaths: uniqueSorted([
        ...project.disabledSkillPaths,
        ...user.disabledSkillPaths
      ]),
      disableBundledSkills: project.disableBundledSkills || user.disableBundledSkills
    },
    projectPath: paths.projectPath,
    userPath: paths.userPath
  };
}

export async function saveSkillSettingsLayer(
  paths: SkillSettingsPaths,
  target: SkillConfigTarget,
  layer: SkillSettingsLayer
): Promise<void> {
  const filePath = target === "project" ? paths.projectPath : paths.userPath;
  const parentDirectory = path.dirname(filePath);
  await fs.mkdir(parentDirectory, { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSkillSettingsLayer(layer), null, 2)}\n`,
    "utf8"
  );
}

export function normalizeSkillSettingsLayer(
  input?: Partial<SkillSettingsLayer> | null
): SkillSettingsLayer {
  return {
    disabledSkillIds: uniqueSorted((input?.disabledSkillIds ?? []).map(normalizeIdentifier)),
    disabledSkillNames: uniqueSorted((input?.disabledSkillNames ?? []).map(normalizeSkillName)),
    disabledSkillPaths: uniqueSorted((input?.disabledSkillPaths ?? []).map(normalizeIdentifier)),
    disableBundledSkills: input?.disableBundledSkills === true
  };
}

export function normalizeSkillIdentifier(value: string) {
  return normalizeIdentifier(value);
}

export function normalizeSkillName(value: string) {
  return value.trim().toLowerCase();
}

function serializeSkillSettingsLayer(layer: SkillSettingsLayer) {
  return compactObject({
    disabledSkillIds: layer.disabledSkillIds,
    disabledSkillNames: layer.disabledSkillNames,
    disabledSkillPaths: layer.disabledSkillPaths,
    disableBundledSkills: layer.disableBundledSkills ? true : undefined
  });
}

async function readSkillSettingsFile(filePath: string): Promise<Partial<SkillSettingsLayer>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  return SkillSettingsFileSchema.parse(parsed);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeIdentifier(value: string) {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[A-Z]:/, (match) => match.toLowerCase())
    .toLowerCase();
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === undefined) {
        return false;
      }

      if (Array.isArray(entry)) {
        return entry.length > 0;
      }

      return true;
    })
  );
}
