import { t } from "../../i18n/index.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import { terminalUiTheme } from "../theme/theme.js";

const MAX_VISIBLE_QUEUED_INPUTS = 3;

// 排队内容折成单行显示：换行和多余空白都压掉，否则一条长输入会顶掉整个输入区。
export function formatQueuedInputPreview(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function QueuedInputPanel(props: { queuedInputs: string[] }) {
  if (props.queuedInputs.length === 0) {
    return null;
  }

  const visibleInputs = props.queuedInputs.slice(0, MAX_VISIBLE_QUEUED_INPUTS);
  const hiddenCount = props.queuedInputs.length - visibleInputs.length;

  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
        {t("queuedInputPanel.title", { count: props.queuedInputs.length })}
      </Text>
      {visibleInputs.map((input, index) => (
        <Text
          key={`${index}-${input}`}
          color={terminalUiTheme.colors.subtle}
          wrap="truncate-end"
        >
          {"  "}
          {index + 1}. {formatQueuedInputPreview(input)}
        </Text>
      ))}
      {hiddenCount > 0 ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          {t("queuedInputPanel.hiddenInputs", { count: hiddenCount })}
        </Text>
      ) : null}
    </Box>
  );
}
