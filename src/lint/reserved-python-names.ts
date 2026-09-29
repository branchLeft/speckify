import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

interface ReservedPythonNames {
  openapiPythonClient: {
    version: string;
    modelMembers: string[];
    reservedWords: string[];
  };
  pydantic: {
    version: string;
    baseModelMembers: string[];
  };
}

/**
 * `reserved-python-names.json`, derived from the pinned toolchain's
 * installed `openapi-python-client` and `pydantic` by
 * `python/derive_reserved_model_members.py` (see
 * `reserved-python-model-member.test.ts` for the drift check that re-runs
 * it against the installed packages).
 */
const data = JSON.parse(
  readFileSync(join(moduleDir, 'reserved-python-names.json'), 'utf8'),
) as ReservedPythonNames;

/**
 * Every member name openapi-python-client's own attrs model template
 * (`to_dict`, `from_dict`, and — whenever a schema doesn't set
 * `additionalProperties: false` — `additional_properties`,
 * `additional_keys`) contributes to a generated model class, regardless of
 * that model's own declared properties.
 */
export const OPENAPI_PYTHON_CLIENT_MODEL_MEMBERS: ReadonlySet<string> = new Set(
  data.openapiPythonClient.modelMembers,
);

/**
 * The names `fix_reserved_words()` suffixes with `_` before openapi-python-client
 * ever gets to checking model-member collisions — `dir(builtins)` plus a
 * handful of extras, minus `id`, and every Python keyword.
 */
export const OPENAPI_PYTHON_CLIENT_RESERVED_WORDS: ReadonlySet<string> = new Set(
  data.openapiPythonClient.reservedWords,
);

/**
 * `pydantic.BaseModel`'s own public members. datamodel-code-generator
 * already renames any colliding property away (`dict` -> `dict_`, aliased)
 * before it can shadow one of these — see
 * `reserved-python-model-member.test.ts`'s `pydantic auto-rename` case,
 * which fails loudly if a future pydantic method ever escapes that net.
 */
export const PYDANTIC_BASE_MODEL_MEMBERS: ReadonlySet<string> = new Set(
  data.pydantic.baseModelMembers,
);
