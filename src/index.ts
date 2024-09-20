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

      /**
       * Given a file, recursively load queries and fragments from it and any files it imports from.
       */
      const recursivelyIndex = async (id: string) => {
        const contents = readFileSync(id, "utf8");
        const imports = parseImports(contents);
        for (const query of getQueries(contents)) {
          if (query.source.includes("fragment ")) {
            fragmentValues.set(query.name, query);
          }

          if (query.deps) {
            for (const dep of query.deps) {
              const importSource = imports.get(dep);
              if (importSource && !fragmentValues.has(dep)) {
                const resolved = await this.resolve(importSource, id);
                if (!resolved) throw new Error(`Cannot resolve ${importSource} from ${id}`);
                await recursivelyIndex(resolved.id);
              }
            }
          }
        }
      };

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
              const resolved = await this.resolve(importSource, id);
              if (!resolved) throw new Error(`Cannot resolve ${importSource} from ${id}`);
              // in dev mode, this.load will not load the file (because, pfft, who would want that?)
              // so we need to manually index the files queries.
              // but in other modes, like `vite build`, this.load will load the file and run transforms,
              // so we can rely on that which is faster.
              // todo: there must be a better way to do this, but i can't find it.
              if (isDevServer) {
                // this is ugly, but it *should* be fine because we should only have to index a file once
                // and usually only 2-3 files per page load in dev.
                await recursivelyIndex(resolved.id);
              } else {
                await this.load(resolved);
              }
            }

            const fragment = fragmentValues.get(depName);
            if (!fragment) throw new Error(`Fragment ${depName} not found`);

            if (merged.includes(fragment.source)) {
              // this shouldn't really happen, but just in case. if we've already
              // added the fragment, we don't need to do it again. we can also assume we've
              // already added the dependencies.
              return;
            }

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
