import { readFile, writeFile } from "fs/promises";
import {
  buildSchema,
  getIntrospectionQuery,
  introspectionFromSchema,
  type IntrospectionOptions,
  type IntrospectionQuery,
} from "graphql/utilities";
import hashObject from "hash-object";

export interface WriteIntrospectionOptions {
  schema: string;
  possibleTypesPath?: string;
  schemaPath?: string;
  options?: IntrospectionOptions;
  /** @internal */
  __currentHash?: string;
}

const toPossibleTypes = (introspection: IntrospectionQuery) => {
  const possibleTypes: Record<string, string[]> = {};
  for (const supertype of introspection.__schema.types) {
    if ("possibleTypes" in supertype && supertype.possibleTypes) {
      possibleTypes[supertype.name] = supertype.possibleTypes.map((subtype) => subtype.name);
    }
  }

  return possibleTypes;
};

const writePossibleTypesFile = async (options: WriteIntrospectionOptions) => {
  const contents = await readFile(options.schema, "utf8");
  const schema = buildSchema(contents);
  const introspection = introspectionFromSchema(schema, options?.options);

  const hash = hashObject(introspection);
  if (options.__currentHash === hash) {
    return hash;
  }

  if (options.possibleTypesPath) {
    const possibleTypes = toPossibleTypes(introspection);
    await writeFile(options.possibleTypesPath, JSON.stringify(possibleTypes, null, 2));
  }

  if (options.schemaPath) {
    await writeFile(options.schemaPath, JSON.stringify(introspection, null, 2));
  }

  return hash;
};

const writePossibleTypesUri = async (options: WriteIntrospectionOptions) => {
  const response = await fetch(options.schema, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      variables: {},
      query: getIntrospectionQuery(options.options),
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Failed to fetch introspection: ${message}`);
  }

  const result = (await response.json()) as { data: IntrospectionQuery };
  const introspection = result.data;

  const hash = hashObject(introspection);
  if (options.__currentHash === hash) {
    return hash;
  }

  if (options.possibleTypesPath) {
    const possibleTypes = toPossibleTypes(introspection);
    await writeFile(options.possibleTypesPath, JSON.stringify(possibleTypes, null, 2));
  }

  if (options.schemaPath) {
    await writeFile(options.schemaPath, JSON.stringify(introspection, null, 2));
  }

  return hash;
};

export const writeIntrospection = async (options: WriteIntrospectionOptions): Promise<string> => {
  if (options.schema.startsWith("http")) {
    return writePossibleTypesUri(options);
  }

  return writePossibleTypesFile(options);
};
