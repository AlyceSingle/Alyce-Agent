import { createContext } from "react";
import type { DOMElement } from "./vendor/ink/dom.js";

export type CursorDeclaration = {
  relativeX: number;
  relativeY: number;
  node: DOMElement;
};

export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null
) => void;

const CursorDeclarationContext = createContext<CursorDeclarationSetter>(() => {});

export default CursorDeclarationContext;
