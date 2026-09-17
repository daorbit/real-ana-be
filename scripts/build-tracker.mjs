// Minifies the tracker source into the file actually served at `/tracker.js`.
//
// `src/tracker/tracker.src.js` is the readable, commented source — edit that,
// never `public/tracker.js` directly, since this script overwrites it. Object
// property names are left alone (`mangle.props` is not set): the JSON keys
// this script sends over the wire (utm_source, clickTag, etc) are read by
// exact name in `collect.ts`/`track.ts`, and mangling them would silently
// break every site already embedding the old, unminified script the moment
// they picked up the new one.

import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(__dirname, "..", "src", "tracker", "tracker.src.js")],
  outfile: path.join(__dirname, "..", "public", "tracker.js"),
  bundle: false,
  minify: true,
  target: "es2018",
  legalComments: "none",
});

console.log("[build-tracker] public/tracker.js rebuilt from src/tracker/tracker.src.js");
