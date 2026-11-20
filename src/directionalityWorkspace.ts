// Lazy entry point of the Directionality workspace (its own chunk, loaded on first use).
import "./directionality/directionality.css";
import { runApp, type DirectionalityHandle } from "./directionality/app";

export type { DirectionalityHandle };

export function mountDirectionality(view: HTMLElement, panel: HTMLElement): Promise<DirectionalityHandle | null> {
  return runApp(view, panel);
}
