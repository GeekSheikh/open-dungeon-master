"use client";

import { useLayoutEffect, useState, type CSSProperties } from "react";

// A speaker's portrait in the story log, sized to the words beside it: a
// one-line remark gets a face as tall as its name and bubble, a long speech
// a larger one, up to the cap the stylesheet sets (--face-max in
// session.css). The art players make for their characters was drawn at the
// 40px a token needs on the board; the log has room to show it.
//
// CSS alone cannot size a circle to the height of the text next to it (a
// flex item's width is settled before its stretched height), so the text
// column is measured and its height handed to the stylesheet as --face-size,
// where clamp() keeps it between the old size and the cap. Returns the
// style for the face and the callback ref for the text column.
export function useFaceSize<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => setHeight(Math.round(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  const style = (height ? { "--face-size": `${height}px` } : {}) as CSSProperties;
  return [style, setElement] as const;
}
