import { SkillManager, extractPathMentions } from "./manager.js";
import {
  createSkillId,
  discoverSkills,
  discoverSkillsFromRoot,
  findSkillByName,
  normalizeSkillName,
  parseSkillMarkdown
} from "./loader.js";
import {
  extractSkillMentions,
  formatPromptEntry,
  formatSkillContentMessage,
  toPromptEntry
} from "./render.js";
import type {
  SkillActivationContext,
  SkillCatalog,
  SkillConfigMutationResult,
  SkillConfigTarget,
  SkillDescriptor,
  SkillDiscoveryRoots,
  SkillFrontmatterValue,
  SkillMentionResolution,
  SkillMetadata,
  SkillPromptContext,
  SkillPromptEntry,
  SkillReference,
  SkillServiceOptions,
  SkillSource
} from "./types.js";

export type {
  SkillActivationContext,
  SkillCatalog,
  SkillConfigMutationResult,
  SkillConfigTarget,
  SkillDescriptor,
  SkillDiscoveryRoots,
  SkillFrontmatterValue,
  SkillMentionResolution,
  SkillMetadata,
  SkillPromptContext,
  SkillPromptEntry,
  SkillReference,
  SkillServiceOptions,
  SkillSource
};

export {
  createSkillId,
  discoverSkills,
  discoverSkillsFromRoot,
  extractPathMentions,
  extractSkillMentions,
  findSkillByName,
  formatPromptEntry,
  formatSkillContentMessage,
  normalizeSkillName,
  parseSkillMarkdown,
  toPromptEntry
};

export class SkillService {
  private readonly manager: SkillManager;

  constructor(options: SkillServiceOptions) {
    this.manager = new SkillManager(options);
  }

  getRoots(): SkillDiscoveryRoots {
    return this.manager.getRoots();
  }

  setProjectTrusted(trusted: boolean) {
    this.manager.setProjectTrusted(trusted);
  }

  async discoverSkills(options: {
    activationContext?: SkillActivationContext;
  } = {}): Promise<SkillCatalog> {
    return this.manager.discoverSkills(options);
  }

  async findSkillByName(
    name: string,
    options: {
      includeDisabled?: boolean;
    } = {}
  ): Promise<{
    skill?: SkillDescriptor;
    catalog: SkillCatalog;
    disabled: boolean;
  }> {
    return this.manager.findSkillByName(name, options);
  }

  async buildPromptContext(options: {
    charBudget?: number;
    activationContext?: SkillActivationContext;
  } = {}): Promise<SkillPromptContext> {
    return this.manager.buildPromptContext(options);
  }

  async resolveMentionedSkills(input: string): Promise<SkillMentionResolution> {
    return this.manager.resolveMentionedSkills(input);
  }

  async setSkillEnabled(
    reference: SkillReference,
    enabled: boolean,
    target: SkillConfigTarget
  ): Promise<SkillConfigMutationResult> {
    return this.manager.setSkillEnabled(reference, enabled, target);
  }

  async refresh(): Promise<SkillCatalog> {
    return this.manager.refresh();
  }

  close() {
    this.manager.close();
  }
}
