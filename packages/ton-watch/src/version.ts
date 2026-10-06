import packageJson from "../package.json" with { type: "json" };

/** The running ton-watch version (from `package.json`). */
export const VERSION: string = packageJson.version;
