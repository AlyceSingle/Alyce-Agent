export type SkillSource = "project" | "user" | "bundled";
export type SkillFrontmatterValue = string | string[] | boolean;

export interface SkillDependency {
  type: "generic" | "mcp_server" | "mcp_tool";
  name: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription: string;
  whenToUse?: string;
  version?: string;
  pluginId?: string;
  allowedTools: string[];
  userInvocable?: boolean;
  activationPaths: string[];
  dependencies: SkillDependency[];
  body: string;
  frontmatter: Record<string, SkillFrontmatterValue>;
}

export interface SkillDescriptor {
  id: string;
  name: string;
  normalizedName: string;
  description: string;
  shortDescription: string;
  whenToUse?: string;
  version?: string;
  pluginId?: string;
  allowedTools: string[];
  userInvocable?: boolean;
  activationPaths: string[];
  dependencies: SkillDependency[];
  source: SkillSource;
  skillFilePath: string;
  baseDirectory: string;
  content: string;
  sampleFiles: string[];
  duplicatePaths: string[];
  disabledReason?: string;
}

export interface SkillDiscoveryRoots {
  projectRoot: string;
  userRoot: string;
}

export interface SkillCatalog {
  skills: SkillDescriptor[];
  disabledSkills: SkillDescriptor[];
  duplicateWarnings: string[];
  disabledWarnings: string[];
  configWarnings: string[];
}

export interface SkillPromptEntry {
  name: string;
  source: SkillSource;
  description: string;
  shortDescription: string;
  whenToUse?: string;
}

export interface SkillPromptContext {
  skills: SkillPromptEntry[];
  totalCount: number;
  truncatedCount: number;
  duplicateWarnings: string[];
  charBudget: number;
}

export interface SkillMentionResolution {
  mentions: string[];
  resolvedSkills: SkillDescriptor[];
  unresolvedMentions: string[];
  disabledMentions: string[];
  duplicateWarnings: string[];
  disabledWarnings: string[];
}

export interface SkillActivationContext {
  workspaceRoot: string;
  referencedPaths?: string[];
  openedPaths?: string[];
}

export interface SkillServiceOptions {
  workspaceRoot: string;
  userHomeDirectory?: string;
  promptCharBudget?: number;
  watch?: boolean;
}

export type SkillConfigTarget = "project" | "user";

export type SkillReference =
  | { kind: "name"; value: string }
  | { kind: "id"; value: string }
  | { kind: "path"; value: string }
  | { kind: "bundled" };

export interface SkillConfigMutationResult {
  changed: boolean;
  target: SkillConfigTarget;
  configPath: string;
  catalog: SkillCatalog;
  message: string;
}
