import { useCallback, useContext, useLayoutEffect, useRef } from "react";
import CursorDeclarationContext from "./CursorDeclarationContext.js";
import type { DOMElement } from "./vendor/ink/dom.js";

export function useDeclaredCursor(props: {
  line: number;
  column: number;
  active: boolean;
}) {
  const setCursorDeclaration = useContext(CursorDeclarationContext);
  const nodeRef = useRef<DOMElement | null>(null);

  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node;
  }, []);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (props.active && node) {
      setCursorDeclaration({
        relativeX: props.column,
        relativeY: props.line,
        node
      });
      return;
    }

    setCursorDeclaration(null, node);
  });

  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current);
    };
  }, [setCursorDeclaration]);

  return setNode;
}
