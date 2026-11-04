// ESLint for the SwimReader frontends — correctness rules only, no style rules.
//
// Formatting is deliberately NOT linted. The pages carry a lot of aligned columns and wide
// explanatory comment blocks that a formatter would reflow, and reflowing 40k lines buys no
// correctness. `.editorconfig` covers indentation for editors; that is enough.
//
// The hard part is `no-undef`. These are CLASSIC scripts, not modules: one page loads several
// files that share a single global scope, so `scope.js` legitimately calls a function declared
// in `handoff.js`. A naive config reports every one of those as undefined — hundreds of false
// positives, which is how a linter gets switched off for good.
//
// So the globals are DERIVED, per page, from everything that page actually loads:
//   - top-level declarations in its own scripts and in the shared scripts every page loads
//   - names published onto `window` (the shared modules are IIFEs that do exactly this:
//     `window.SimBrief = …`, `window.ReplayBar = …`)
//   - both of the above from inline <script> blocks in the page's HTML
// That keeps `no-undef` meaningful — it still catches a typo or a name that moved — and keeps the
// config from being a hand-maintained list that rots. When these pages become ES modules the
// derivation goes away and `no-undef` gets stronger for free.
//
// NOTE: this cannot catch the `window.X` vs lexical-`X` collision that has bitten three times —
// `window.dcb` is a valid member access on a declared global. GlobalScopeContractTests does that.

import js from "@eslint/js";
import globals from "globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WWWROOT = "tools/SwimServer/wwwroot";

const DECL = /^(?:async\s+)?(?:function\*?|var|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const PUBLISHED = /window\.([A-Za-z_$][\w$]*)\s*(?:=[^=]|\|\|=|\?\?=)|Object\.defineProperty\(\s*window\s*,\s*["']([A-Za-z_$][\w$]*)["']/g;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** Every name a source file contributes to the global scope. */
function namesIn(src) {
  const out = [];
  for (const m of src.matchAll(DECL)) out.push(m[1]);
  for (const m of src.matchAll(PUBLISHED)) out.push(m[1] ?? m[2]);
  return out;
}

function filesIn(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Names from a directory's scripts plus the inline blocks of its HTML pages. */
function namesForDir(dir) {
  const out = [];
  for (const f of filesIn(dir, ".js")) out.push(...namesIn(readFileSync(f, "utf8")));
  for (const f of filesIn(dir, ".html")) {
    const html = readFileSync(f, "utf8");
    for (const m of html.matchAll(INLINE_SCRIPT)) out.push(...namesIn(m[1]));
  }
  return out;
}

const sharedNames = namesForDir(join(WWWROOT, "shared"));

function globalsFor(names) {
  return {
    ...globals.browser,
    L: "readonly", // Leaflet, loaded from a CDN tag
    ...Object.fromEntries(names.map((n) => [n, "writable"])),
  };
}

const pageDirs = readdirSync(WWWROOT).filter((d) => {
  if (d === "shared") return false;
  try {
    return statSync(join(WWWROOT, d)).isDirectory() && filesIn(join(WWWROOT, d), ".js").length > 0;
  } catch {
    return false;
  }
});

const pageConfigs = pageDirs.map((page) => ({
  files: [`${WWWROOT}/${page}/**/*.js`],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "script",
    globals: globalsFor([...sharedNames, ...namesForDir(join(WWWROOT, page))]),
  },
}));

export default [
  { ignores: ["**/node_modules/**", "**/bin/**", "**/obj/**", "dstars-port/**", "**/*.min.js"] },

  js.configs.recommended,

  // The shared scripts see only each other plus the browser.
  {
    files: [`${WWWROOT}/shared/**/*.js`, `${WWWROOT}/*.js`],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: globalsFor(sharedNames),
    },
  },

  ...pageConfigs,

  {
    files: [`${WWWROOT}/**/*.js`],
    rules: {
      // The derived globals above include a file's OWN top-level names (they are genuinely
      // globals once the script loads), so without this every single declaration reads as a
      // redeclaration of a built-in — 1,200 false positives on the first run. The rule still
      // catches a real double-declaration inside one file, which is what it is for.
      "no-redeclare": ["error", { builtinGlobals: false }],

      // A WARNING, not an error, and CI pins the count with --max-warnings. There are 57 of
      // these today: dead locals, unused constants and a handful of superseded helpers. Each
      // needs a look — a `const x = f()` whose f() has side effects cannot just be deleted —
      // and doing 57 such edits in one sweep across 15 files of a live display is a worse
      // trade than leaving them visible. So the count is a ratchet: new dead code fails the
      // build, existing dead code is a listed debt that can only shrink. Lower the number in
      // package.json as they go; never raise it.
      //
      // Only locals are reported: an unused parameter is usually a deliberate signature (an
      // event handler ignoring its event). A leading underscore marks "unused on purpose", and
      // a function reached only from an inline on*= attribute gets a /* exported */ directive
      // at the top of its file, since no static analysis can see that reference.
      "no-unused-vars": [
        "warn",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" },
      ],

      // `catch {}` is used on purpose in several places — localStorage access throws in a private
      // window, and a page must render anyway. The pattern is documented; don't flag it.
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Correctness rules worth having beyond recommended.
      "no-constant-binary-expression": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "warn", // a `${}` inside a plain quoted string is nearly always a bug
      "no-unmodified-loop-condition": "error",
      "no-unused-private-class-members": "error",
      eqeqeq: ["warn", "smart"],

      // Explicitly NOT enabled: any rule about spacing, quotes, semicolons, line length or
      // brace placement. See the header.
    },
  },
];
