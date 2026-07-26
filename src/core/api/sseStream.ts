export type ServerSentEvent = {
  event?: string;
  data: string;
};

// 逐行解析 fetch Response 的 text/event-stream 主体。只处理 event/data 字段，
// 注释行（":" 开头）与其余字段按 SSE 规范忽略。
export async function* readServerSentEvents(
  response: Response,
  abortSignal?: AbortSignal
): AsyncGenerator<ServerSentEvent> {
  const body = response.body;
  if (!body) {
    return;
  }

  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const flush = (): ServerSentEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }

    const event: ServerSentEvent = {
      data: dataLines.join("\n"),
      ...(eventName ? { event: eventName } : {})
    };
    eventName = undefined;
    dataLines = [];
    return event;
  };

  try {
    while (true) {
      if (abortSignal?.aborted) {
        const error = new Error("Request aborted");
        error.name = "AbortError";
        throw error;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (line === "") {
          const event = flush();
          if (event) {
            yield event;
          }
          continue;
        }

        if (line.startsWith(":")) {
          continue;
        }

        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trimStart();
          continue;
        }

        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).replace(/^ /, ""));
        }
      }
    }

    const event = flush();
    if (event) {
      yield event;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
