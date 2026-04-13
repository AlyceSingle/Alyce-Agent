function prependBullets(items: ReadonlyArray<string | ReadonlyArray<string>>): string[] {
  return items.flatMap((item) =>
    Array.isArray(item)
      ? item.map((subitem) => `  - ${subitem}`)
      : [`- ${item}`]
  );
}

function buildSection(title: string, items: ReadonlyArray<string | ReadonlyArray<string>>) {
  return [`# ${title}`, ...prependBullets(items)].join("\n");
}

export const promptFormatting = {
  prependBullets,
  buildSection
};
