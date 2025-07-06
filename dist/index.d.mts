import { Plugin } from 'vite';
import { IntrospectionOptions } from 'graphql/utilities';

interface WriteIntrospectionOptions {
    schema: string;
    possibleTypesPath?: string;
    schemaPath?: string;
    urqlSchemaPath?: string;
    options?: IntrospectionOptions;
}

interface PersistedQueriesOptions {
    outputPath: string;
    addTypename?: boolean;
    enabled?: boolean;
    removeSource?: boolean;
    introspection?: WriteIntrospectionOptions;
}
declare const persistedQueries: (options: PersistedQueriesOptions) => Plugin;

export { type PersistedQueriesOptions, persistedQueries };
