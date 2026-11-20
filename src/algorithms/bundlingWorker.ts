/// <reference lib="webworker" />
/**
 * Module Web Worker around bundleEdges.
 *
 *   const worker = new Worker(new URL("./bundlingWorker.ts", import.meta.url), { type: "module" });
 *   worker.postMessage({ type: "bundle", edges, values, options } satisfies BundlingRequest);
 *
 * The worker answers with any number of "progress" messages (at most about 20 per second),
 * followed by exactly one "done" (whose typed arrays are transferred, not copied) or "error".
 * bundleEdges runs synchronously, so the worker cannot receive a cancel message while it is
 * busy: to cancel, call worker.terminate() and create a new worker.
 */
import { bundleEdges, type BundlingOptions, type Polylines } from "./meanShiftBundling";

export interface BundlingRequest {
  type: "bundle";
  edges: Float32Array;
  values: Float32Array | null;
  options: Partial<BundlingOptions>;
}

export type BundlingResponse =
  | { type: "progress"; fraction: number }
  | { type: "done"; result: Polylines }
  | { type: "error"; message: string };

/** Minimum time between two progress messages, in ms. */
const PROGRESS_INTERVAL = 50;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: BundlingResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

ctx.onmessage = (event: MessageEvent<BundlingRequest>): void => {
  const request = event.data;
  if (!request || request.type !== "bundle") {
    post({ type: "error", message: "bundlingWorker: unknown message type" });
    return;
  }
  try {
    let lastPost = -Infinity;
    const result = bundleEdges(
      request.edges,
      request.values ?? null,
      request.options ?? {},
      (fraction) => {
        const now = performance.now();
        if (now - lastPost >= PROGRESS_INTERVAL) {
          lastPost = now;
          post({ type: "progress", fraction });
        }
      },
    );
    post({ type: "progress", fraction: 1 });
    post({ type: "done", result }, [
      result.points.buffer,
      result.offsets.buffer,
      result.values.buffer,
    ]);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
