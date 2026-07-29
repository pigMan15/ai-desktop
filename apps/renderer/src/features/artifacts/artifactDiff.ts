export type ArtifactDiffLine = {
  kind: "unchanged" | "added" | "removed";
  text: string;
};

export function diffArtifactText(before: string, after: string): ArtifactDiffLine[] {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const table = Array.from({ length: beforeLines.length + 1 }, () =>
    Array<number>(afterLines.length + 1).fill(0),
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? table[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }

  const result: ArtifactDiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      result.push({ kind: "unchanged", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex === beforeLines.length ||
        table[beforeIndex][afterIndex + 1] > table[beforeIndex + 1][afterIndex])
    ) {
      result.push({ kind: "added", text: afterLines[afterIndex] });
      afterIndex += 1;
    } else {
      result.push({ kind: "removed", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
    }
  }
  return result;
}

function splitLines(value: string): string[] {
  return value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
}
