const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const preload = globalThis.__PUBLIC_ENTRY_FONT_PREFLIGHT__;
assert.ok(preload, "font-loader-preload.cjs must run before the Next loader");
assert.ok(isAbsolute(preload.responses));
assert.equal(
  preload.responses,
  resolve(__dirname, "font-loader-responses.cjs"),
);
assert.equal(process.env.TZ, "UTC");

const loader =
  require("next/dist/compiled/@next/font/dist/google/loader.js").default;
const sourceFont = resolve(__dirname, "../../public/fonts/Format_1452.woff2");
const sourceBytes = readFileSync(sourceFont);
const responses = require(preload.responses);

const configurations = [
  {
    functionName: "Inter",
    data: {
      subsets: ["latin"],
      variable: "--font-minimal",
      display: "swap",
    },
    emittedUrl: "/__public_entry_fonts/inter.woff2",
    response:
      responses[
        "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap"
      ],
  },
  {
    functionName: "Jost",
    data: {
      subsets: ["latin"],
      weight: ["300", "400", "500", "600"],
      variable: "--font-sans",
      display: "swap",
    },
    emittedUrl: "/__public_entry_fonts/jost.woff2",
    response:
      responses[
        "https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&display=swap"
      ],
  },
  {
    functionName: "Cormorant_Garamond",
    data: {
      subsets: ["latin"],
      weight: ["300", "400", "500"],
      style: ["italic", "normal"],
      variable: "--font-display",
      display: "swap",
    },
    emittedUrl: "/__public_entry_fonts/cormorant-garamond.woff2",
    response:
      responses[
        "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&display=swap"
      ],
  },
];

async function load(configuration, isDev = false) {
  const emissions = [];
  const result = await loader({
    functionName: configuration.functionName,
    data: [configuration.data],
    emitFontFile(content, ext, preloadFontFile, isUsingSizeAdjust) {
      emissions.push({
        content,
        ext,
        preloadFontFile,
        isUsingSizeAdjust,
      });
      return configuration.emittedUrl;
    },
    isDev,
    isServer: true,
    variableName: configuration.functionName,
  });
  return { emissions, result };
}

async function main() {
  if (process.env.FONT_LOADER_PREFLIGHT_CASE === "MISS") {
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    let miss;
    try {
      miss = await load(
        {
          ...configurations[0],
          data: { ...configurations[0].data, display: "block" },
        },
        true,
      );
    } finally {
      console.error = original;
    }
    assert.equal(miss.emissions.length, 0);
    assert.match(miss.result.css, /font-family: 'Inter Fallback'/);
    assert.ok(errors.length >= 1);
    process.stderr.write(
      "Font loader preflight rejected an unaccepted valid configuration.\n",
    );
    process.exitCode = 70;
    return;
  }

  for (const configuration of configurations) {
    const { emissions, result } = await load(configuration);
    assert.equal(emissions.length, 1);
    assert.deepEqual(emissions[0].content, sourceBytes);
    assert.deepEqual(
      {
        ext: emissions[0].ext,
        preloadFontFile: emissions[0].preloadFontFile,
        isUsingSizeAdjust: emissions[0].isUsingSizeAdjust,
      },
      {
        ext: "woff2",
        preloadFontFile: true,
        isUsingSizeAdjust: true,
      },
    );
    assert.equal(
      result.css,
      configuration.response.split(sourceFont).join(configuration.emittedUrl),
    );
    assert.ok(!result.css.includes("https://"));
    assert.ok(!result.css.includes(sourceFont));
  }
  process.stdout.write(
    JSON.stringify({
      kind: "PUBLIC_ENTRY_FONT_LOADER_PREFLIGHT",
      configurations: configurations.map(({ functionName }) => functionName),
      emissions: configurations.length,
    }) + "\n",
  );
}

const deadline = setTimeout(() => {
  process.stderr.write("Font loader preflight exceeded its finite deadline.\n");
  process.exit(70);
}, 5_000);
void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 70;
  })
  .finally(() => clearTimeout(deadline));
