// Entry point of `npm run export:blender` (see tools/blenderExport.ts for the options).
import { main } from "./blenderExport";

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
