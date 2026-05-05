import { promises as fs } from "node:fs";

export async function assertFileStillMissingAfterApproval(
  absolutePath: string,
  message: string
) {
  if (await fileExists(absolutePath)) {
    throw new Error(message);
  }
}

export async function assertExistingFileBytesUnchangedAfterApproval(
  absolutePath: string,
  originalBytes: Buffer,
  options: {
    toolName: string;
    deletedRetryAction: string;
    changedRetryAction: string;
  }
) {
  let currentBytes: Buffer;
  try {
    currentBytes = await fs.readFile(absolutePath);
  } catch (error) {
    if (isEnoentError(error)) {
      throw new Error(
        `File was deleted while ${options.toolName} was awaiting approval. Use Read again before ${options.deletedRetryAction}.`
      );
    }

    throw error;
  }

  if (!currentBytes.equals(originalBytes)) {
    throw new Error(
      `File changed while ${options.toolName} was awaiting approval. Use Read again before ${options.changedRetryAction}.`
    );
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isEnoentError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
