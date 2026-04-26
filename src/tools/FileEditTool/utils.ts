import type { FileEdit } from "./types.js";

export function applyEditToFile(fileContent: string, edit: FileEdit): string {
  // replace_all=true 时做全量替换，否则只替换首个命中。
  return edit.replace_all
    ? fileContent.split(edit.old_string).join(edit.new_string)
    : fileContent.replace(edit.old_string, edit.new_string);
}

export function getPatchForEdit(options: {
  filePath: string;
  fileContents: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}) {
  const edit: FileEdit = {
    old_string: options.oldString,
    new_string: options.newString,
    replace_all: Boolean(options.replaceAll)
  };

  const updatedFile = applyEditToFile(options.fileContents, edit);
  const patch = [
    {
      oldStart: 1,
      oldLines: options.fileContents.length === 0 ? 0 : options.fileContents.split(/\r?\n/).length,
      newStart: 1,
      newLines: updatedFile.length === 0 ? 0 : updatedFile.split(/\r?\n/).length,
      lines: [
        `--- ${options.filePath}`,
        `+++ ${options.filePath}`,
        `- ${summarize(options.fileContents)}`,
        `+ ${summarize(updatedFile)}`
      ]
    }
  ];

  return { patch, updatedFile };
}

function summarize(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= 120) {
    return flattened;
  }

  return `${flattened.slice(0, 117)}...`;
}
