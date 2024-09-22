import { addTypenameToDocument } from "@apollo/client/utilities";
import { printExecutableGraphQLDocument } from "@graphql-tools/documents";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { parse } from "graphql";
import MagicString from "magic-string";
import { getQueries, type Query } from "./helpers/get-queries";
import { parseImports } from "./helpers/parse-imports";
import type { Plugin } from "vite";
import { writeIntrospection, type WriteIntrospectionOptions } from "./helpers/write-introspection";

export interface PersistedQueriesOptions {
  outputPath: string;
  addTypename?: boolean;
  enabled?: boolean;
  removeSource?: boolean;
  introspection?: WriteIntrospectionOptions;
}

export const persistedQueries = (options: PersistedQueriesOptions): Plugin => {
  if (options.enabled === false) {
    return { name: "vite-plugin-gql-tada-persisted-queries" };
  }

  const queryValues = new Map<string, Query>();
  const queryHashMap = new Map<string, string>();
  const indexed = new Set<string>();
  let isDevServer = false;

  function loadExistingQueries() {
    try {
      const contents = readFileSync(options.outputPath, "utf8");
      const parsed = JSON.parse(contents) as Record<string, string>;
      for (const [hash, serialized] of Object.entries(parsed)) {
        queryHashMap.set(hash, serialized);
      }
    } catch (error) {
      console.warn(`Failed to load existing queries from ${options.outputPath}. Creating a new file.`);
      writeFileSync(options.outputPath, "{}");
    }
  }

  function writeQueryMap() {
    const data = Object.fromEntries(queryHashMap);
    writeFileSync(options.outputPath, JSON.stringify(data, null, 2));
  }

  function hashQuery(query: string): string {
    return createHash("sha256").update(query).digest("hex");
  }

  function processQuery(query: Query): { hash: string; serialized: string } {
    let mergedQuery = query.source;

    function addDependencies(name: string) {
      const dep = queryValues.get(name);
      if (!dep) throw new Error(`Fragment ${name} not found`);
      if (!mergedQuery.includes(dep.source)) mergedQuery += dep.source;
      dep.deps?.forEach(addDependencies);
    }

    addDependencies(query.name);

    let parsedQuery = parse(mergedQuery);
    if (options.addTypename) {
      parsedQuery = addTypenameToDocument(parsedQuery);
    }

    const serializedQuery = printExecutableGraphQLDocument(parsedQuery);
    const queryHash = hashQuery(serializedQuery);
    queryHashMap.set(queryHash, serializedQuery);

    return { hash: queryHash, serialized: serializedQuery };
  }

  let _writeTimeout: NodeJS.Timeout | null = null;
  let currentIntroHash: string | undefined;
  function writeDebounce() {
    if (_writeTimeout) clearTimeout(_writeTimeout);
    _writeTimeout = setTimeout(() => {
      writeQueryMap();
      if (options.introspection) {
        writeIntrospection({
          ...options.introspection,
          __currentHash: currentIntroHash,
        })
          .then((hash) => {
            currentIntroHash = hash;
          })
          .catch((error) => {
            console.error("Failed to write introspection", error);
          });
      }
      _writeTimeout = null;
    }, 500);
  }

  return {
    name: "vite-plugin-gql-tada-persisted-queries",
    buildEnd: async () => {
      writeQueryMap();
      if (options.introspection) {
        await writeIntrospection(options.introspection);
      }
    },
    configResolved: (config) => {
      isDevServer = config.command === "serve";
      loadExistingQueries();
    },
    transform: async function (code, id) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx")) return;
      if (id.includes("node_modules")) return;
      if (!code.includes("graphql")) return;

      if (isDevServer) {
        indexed.delete(id);
      }

      /** Indexes all graphql() calls in a file recursively, including imported calls */
      const indexFile = async (code: string, id: string) => {
        if (indexed.has(id)) return;
        indexed.add(id);

        const imports = parseImports(code);
        for (const query of getQueries(code)) {
          if (query.deps) {
            for (const dep of query.deps) {
              const importSource = imports.get(dep);
              if (importSource && !queryValues.has(dep)) {
                const resolved = await this.resolve(importSource, id);
                if (!resolved) throw new Error(`Cannot resolve ${importSource} from ${id}`);
                if (isDevServer) {
                  // with the dev server, this.load() is effectively a no-op. transform() is never called
                  // on this.load'd files, so we have to load them and index them manually.
                  // todo: there must be a better way to do this, but i can't find it.
                  const contents = readFileSync(resolved.id, "utf8");
                  await indexFile(contents, resolved.id);
                } else {
                  await this.load(resolved);
                }
              }
            }
          }

          queryValues.set(query.name, query);
        }
      };

      await indexFile(code, id);

      let modified = false;
      const ast = new MagicString(code);
      for (const raw of getQueries(code)) {
        const query = queryValues.get(raw.name);
        if (!query) {
          throw new Error(`Query ${raw.name} not found`);
        }

        const { hash, serialized } = processQuery(query);
        const replacement = options.removeSource
          ? `${query.name} = /* @__PURE__ */ graphql.persisted(\`${hash}\`)`
          : `${query.name} = /* @__PURE__ */ graphql.persisted(\`${hash}\`, graphql(\`${serialized}\`))`;

        ast.overwrite(...query.index, replacement);
        modified = true;
      }

      if (isDevServer) {
        // in dev mode the buildEnd hook is not called, so we need to write the file every time
        // todo: probably a better way to do this?
        writeDebounce();
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
