import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import Box from "./vendor/ink/components/Box.js";

type ScrollDomNode = {
  scrollHeight?: number;
  scrollTop?: number;
  scrollViewportHeight?: number;
  stickyScroll?: boolean;
};

export type ScrollBoxHandle = {
  scrollTo: (y: number) => void;
  scrollBy: (delta: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getScrollHeight: () => number;
  getViewportHeight: () => number;
  isSticky: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export type ScrollBoxProps = {
  children?: React.ReactNode;
  stickyScroll?: boolean;
  [key: string]: unknown;
};

export const ScrollBox = forwardRef<ScrollBoxHandle, ScrollBoxProps>(function ScrollBox(
  { children: rawChildren, stickyScroll: stickyScrollProp = false, ...style },
  ref
) {
  const children = rawChildren as React.ReactNode;
  const stickyScroll = Boolean(stickyScrollProp);
  const domRef = useRef<ScrollDomNode | null>(null);
  const listenersRef = useRef(new Set<() => void>());
  const [, forceRender] = useState(0);

  const notifyListeners = () => {
    for (const listener of listenersRef.current) {
      listener();
    }
  };

  const requestRender = () => {
    forceRender((current) => current + 1);
  };

  const clampScrollTop = (value: number) => {
    const element = domRef.current;
    if (!element) {
      return 0;
    }

    const maxScroll = Math.max(
      0,
      (element.scrollHeight ?? 0) - (element.scrollViewportHeight ?? 0)
    );

    return Math.max(0, Math.min(Math.floor(value), maxScroll));
  };

  useEffect(() => {
    if (!domRef.current) {
      return;
    }

    domRef.current.stickyScroll = stickyScroll;
    if (stickyScroll) {
      requestRender();
    }
  }, [stickyScroll]);

  useImperativeHandle(ref, () => ({
    scrollTo: (y) => {
      const element = domRef.current;
      if (!element) {
        return;
      }

      element.stickyScroll = false;
      element.scrollTop = clampScrollTop(y);
      notifyListeners();
      requestRender();
    },
    scrollBy: (delta) => {
      const element = domRef.current;
      if (!element) {
        return;
      }

      element.stickyScroll = false;
      element.scrollTop = clampScrollTop((element.scrollTop ?? 0) + delta);
      notifyListeners();
      requestRender();
    },
    scrollToBottom: () => {
      const element = domRef.current;
      if (!element) {
        return;
      }

      element.stickyScroll = true;
      notifyListeners();
      requestRender();
    },
    getScrollTop: () => domRef.current?.scrollTop ?? 0,
    getScrollHeight: () => domRef.current?.scrollHeight ?? 0,
    getViewportHeight: () => domRef.current?.scrollViewportHeight ?? 0,
    isSticky: () => Boolean(domRef.current?.stickyScroll),
    subscribe: (listener) => {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    }
  }), []);

  const elementProps: Record<string, unknown> = {
    ref: (element: ScrollDomNode | null) => {
      domRef.current = element;
      if (element) {
        element.scrollTop ??= 0;
        element.stickyScroll = stickyScroll;
      }
    },
    style: {
      flexWrap: "nowrap",
      flexDirection: style.flexDirection ?? "row",
      flexGrow: style.flexGrow ?? 0,
      flexShrink: style.flexShrink ?? 1,
      ...style,
      overflowX: "hidden",
      overflowY: "hidden"
    },
    scrollable: true
  };

  if (stickyScroll) {
    elementProps.stickyScroll = true;
  }

  return React.createElement(
    "ink-box",
    elementProps,
    <Box flexDirection="column" flexGrow={1} flexShrink={0} width="100%">
      {children}
    </Box>
  );
});
