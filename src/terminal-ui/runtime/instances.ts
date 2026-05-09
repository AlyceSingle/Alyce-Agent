import inkInstances from "./ink-runtime/instances.js";

type InkRenderInstance = {
  invalidatePrevFrame?: () => void;
  forceRedraw?: () => void;
};

export function invalidateInkPrevFrame(stdout: NodeJS.WriteStream) {
  const directInstance = inkInstances.get(stdout) as InkRenderInstance | undefined;
  if (directInstance?.invalidatePrevFrame) {
    directInstance.invalidatePrevFrame();
    return;
  }

  for (const instance of inkInstances.values()) {
    const renderInstance = instance as InkRenderInstance;
    if (!renderInstance.invalidatePrevFrame) {
      continue;
    }
    renderInstance.invalidatePrevFrame();
    return;
  }
}

export function forceInkRedraw(stdout: NodeJS.WriteStream) {
  const directInstance = inkInstances.get(stdout) as InkRenderInstance | undefined;
  if (directInstance?.forceRedraw) {
    directInstance.forceRedraw();
    return;
  }

  for (const instance of inkInstances.values()) {
    const renderInstance = instance as InkRenderInstance;
    if (!renderInstance.forceRedraw) {
      continue;
    }
    renderInstance.forceRedraw();
    return;
  }
}

export default inkInstances;
