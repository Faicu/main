import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
await jiti.import("./check-plex-media.ts");
