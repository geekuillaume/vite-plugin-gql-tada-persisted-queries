// import { Fragment, other } from './file'
const IMPORT_PATTERN = /import ?(?<names>[A-z0-9]+|\{[^}]+\}) ?from ?['"](?<source>[^'"]+)['"]/g;

// todo: definitely a better way to do this
export const parseImports = (code: string): Map<string, string> => {
  const imports = new Map<string, string>();
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const source = match.groups!.source!;
    let names = match.groups!.names!;
    if (names.startsWith("{")) names = names.slice(1, -1);
    for (const name of names.split(",")) {
      const [alias] = name.split(" as ");
      imports.set(alias!.trim(), source);
    }
  }

  return imports;
};
