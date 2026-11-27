import type { ZodType } from 'zod';
import type { paths } from '../../contracts/openapi.generated';

export const WEB_API_PREFIX = '/web';

type Method = 'get' | 'post';
type MenuPath = '/stores/{id}/menu';
type MenuQuery = NonNullable<paths[MenuPath]['get']['parameters']['query']>;
type MenuChannel = NonNullable<MenuQuery['channel']>;

type Route<Path extends string> = Path extends `${infer Before}{${string}}${infer After}`
  ? `${Before}${string}${Route<After>}`
  : Path;

// The web adapter adds the prefix centrally, after choosing the authorized session.
type AdapterPath<Path extends keyof paths> = Path extends MenuPath
  ? `${Route<Path>}?channel=${MenuChannel}`
  : Path extends `${typeof WEB_API_PREFIX}${infer Suffix}` ? Route<Suffix> : Route<Path>;

type JsonContent<Value> = { content: { 'application/json': Value } };
type JsonResponse<Operation> = Operation extends { responses: { 200: JsonContent<infer Value> } } ? Value : never;
type RequestBody<Operation> = Operation extends { requestBody: JsonContent<infer Body> }
  ? { body: Body }
  : { body?: never };
type IdempotencyKey<Operation> = Operation extends { parameters: { header: { 'Idempotency-Key': infer Key } } }
  ? { key: Key }
  : { key?: never };

export type CommerceJsonRequest<Path extends keyof paths, Verb extends Method> =
  NonNullable<paths[Path][Verb]> extends never ? never : {
    path: AdapterPath<Path>;
    method: Uppercase<Verb>;
    schema: ZodType<JsonResponse<paths[Path][Verb]>>;
    onHeaders?: (headers: Headers) => void;
  } & RequestBody<paths[Path][Verb]> & IdempotencyKey<paths[Path][Verb]>;
