function prependBullets(items: ReadonlyArray<string | ReadonlyArray<string>>): string[] {
  return items.flatMap((item) =>
    Array.isArray(item)
      ? item.map((subitem) => `  - ${subitem}`)
      : [`- ${item}`]
  );
}

function buildSection(
  title: string,
  items: ReadonlyArray<string | ReadonlyArray<string>>,
  summary?: string
) {
  const lines = summary ? [summary, "", `# ${title}`] : [`# ${title}`];
  return [...lines, ...prependBullets(items)].join("\n");
}

function buildSectionLines(title: string, lines: ReadonlyArray<string>, summary?: string) {
  const sectionHeader = summary ? [summary, "", `# ${title}`] : [`# ${title}`];
  return [...sectionHeader, ...lines].join("\n");
}

export const promptFormatting = {
  prependBullets,
  buildSection,
  buildSectionLines
};
