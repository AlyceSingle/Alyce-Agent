let graphemeSegmenter: Intl.Segmenter | null = null;

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme"
    });
  }

  return graphemeSegmenter;
}

export function lastGrapheme(text: string): string {
  if (!text) {
    return "";
  }

  let last = "";
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    last = segment;
  }

  return last;
}
