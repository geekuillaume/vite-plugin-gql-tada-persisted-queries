import { addTypenameToDocument } from "@apollo/client/utilities";
import { printExecutableGraphQLDocument } from "@graphql-tools/documents";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { parse } from "graphql";
import MagicString from "magic-string";
import { getQueries, type Query } from "./helpers/get-queries";
import { parseImports } from "./helpers/parse-imports";
import type { Plugin } from "vite";

export interface PersistedQueriesOptions {
  outputPath: string;
  addTypename?: boolean;
  enabled?: boolean;
  removeSource?: boolean;
}

export const persistedQueries = (options: PersistedQueriesOptions): Plugin => {
  if (options.enabled === false) {
    return { name: "vite-plugin-gql-tada-persisted-queries" };
  }

  const fragmentValues = new Map<string, Query>();
  const queries = new Map<string, string>();

  try {
    const contents = readFileSync(options.outputPath, "utf8");
    const parsed = JSON.parse(contents) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      queries.set(key, value);
    }
  } catch (e) {
    writeFileSync(options.outputPath, "{}");
  }

  let isDevServer = false;
  const write = () => {
    writeFileSync(options.outputPath, JSON.stringify(Object.fromEntries(queries), null, 2));
  };

  return {
    name: "vite-plugin-gql-tada-persisted-queries",
    buildEnd: () => {
      write();
    },
    configResolved: (config) => {
      isDevServer = config.command === "serve";
    },
    transform: async function (code, id) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return;
      if (id.includes("node_modules")) return;
      if (!code.includes("graphql")) return;

      let modified = false;
      const imports = parseImports(code);
      const ast = new MagicString(code);
      for (const query of getQueries(code)) {
        let merged = query.source;

        if (query.source.includes("fragment ")) fragmentValues.set(query.name, query);
        if (query.deps) {
          const addDependency = async (depName: string) => {
            const importSource = imports.get(depName);
            if (importSource && !fragmentValues.has(depName)) {
              // if the fragment value is not loaded, we need to load it from disk.
              const fileId = await this.resolve(importSource, id);
              if (!fileId) throw new Error(`Cannot resolve ${importSource} from ${id}`);
              // this.load will call this plugins transform(), which will index the fragments
              // so this is all we have to do.
              await this.load(fileId);
              this.parse;
            }

            const fragment = fragmentValues.get(depName);
            if (!fragment) {
              throw new Error(`Fragment ${depName} not found`);
            }

            if (merged.includes(fragment.source)) return;
            merged = merged + "\n" + fragment.source;

            for (const dep of fragment.deps) {
              await addDependency(dep);
            }
          };

          for (const depName of query.deps) {
            await addDependency(depName);
          }
        }

        let parsed = parse(merged);
        if (options.addTypename) parsed = addTypenameToDocument(parsed);
        const serialized = printExecutableGraphQLDocument(parsed);

        const hash = createHash("sha256").update(serialized).digest("hex");
        queries.set(hash, serialized);
        if (isDevServer) {
          // in dev mode the buildEnd hook is not called, so we need to write the file every time
          // todo: probably a better way to do this?
          write();
        }

        // @PURE lets rollup remove the original fragments once we're done,
        // assuming nothing else needs them. without it they are included as dead code.
        if (options.removeSource) {
          ast.overwrite(...query.index, `${query.name} = /* @__PURE__ */ graphql.persisted(\`${hash}\`)`);
        } else {
          ast.overwrite(
            ...query.index,
            `${query.name} = /* @__PURE__ */ graphql.persisted(\`${hash}\`, graphql(\`${serialized}\`))`,
          );
        }

        modified = true;
      }

      if (modified) {
        return {
          code: ast.toString(),
          map: ast.generateMap(),
        };
      }
    },
  };
};
