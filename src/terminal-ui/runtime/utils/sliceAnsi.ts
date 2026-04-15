import sliceAnsiPackage from "slice-ansi";

export default function sliceAnsi(input: string, begin: number, end?: number): string {
  return sliceAnsiPackage(input, begin, end);
}
