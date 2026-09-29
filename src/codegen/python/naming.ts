/** A PEP 503 name is already hyphen-separated lowercase; the import name just swaps hyphens for underscores. */
export function importNameFor(pep503PackageName: string): string {
  return pep503PackageName.replace(/-/g, '_');
}

/**
 * Mirrors datamodel-code-generator's default class-naming: the last JSON
 * Pointer segment of a `$ref`, PascalCased on `-`/`_`/`.` boundaries. Most
 * component schemas are already PascalCase, so this is usually the identity.
 */
export function modelNameFromRef(ref: string): string {
  const lastSegment = ref.split('/').pop() ?? ref;
  const withoutExtension = lastSegment.replace(/\.(json|ya?ml)$/i, '');
  return withoutExtension
    .split(/[-_.]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * The delimiter characters openapi-python-client's `sanitize()` preserves
 * (a dot, space, underscore or hyphen), alongside letters and digits.
 */
const DELIMITERS = '. _-';

/**
 * Mirrors openapi-python-client 0.29.1's `strings.sanitize()`
 * (`openapi_python_client/strings.py`): keeps only characters that are
 * letters, digits, underscores, or one of `DELIMITERS`, dropping everything
 * else.
 */
function sanitizePythonName(value: string): string {
  let result = '';
  for (const char of value) {
    if (/[A-Za-z_0-9]/.test(char) || DELIMITERS.includes(char)) {
      result += char;
    }
  }
  return result;
}

/**
 * Mirrors `strings.split_words()`: when the sanitised value has any
 * uppercase letter, a space is inserted around every `[A-Z]?[a-z]+` run
 * (so a digit run or an acronym like `XML` becomes its own word too), and
 * the result is then split on any run of `DELIMITERS`. This is the step
 * `naming.ts` previously approximated with a single regex, which is why an
 * operationId with a digit (`createThing2`) split wrongly: the real
 * algorithm treats a trailing digit as its own word (`create_thing_2`),
 * not part of the preceding one (`create_thing2`).
 */
function splitPythonWords(sanitized: string): string[] {
  let value = sanitized;
  if (/[A-Z]/.test(value)) {
    value = value.split(/([A-Z]?[a-z]+)/).join(' ');
  }
  return value.match(/[^. _-]+/g) ?? [];
}

/**
 * Mirrors openapi-python-client's `strings.snake_case()`: sanitises,
 * splits into words the way `split_words()` does, and joins them
 * lower-cased with underscores. Doesn't (yet) apply `fix_reserved_words()`
 * or the identifier/prefix fallback `PythonIdentifier` layers on top —
 * see {@link pythonIdentifier} for the full transform.
 */
export function snakeCase(identifier: string): string {
  return splitPythonWords(sanitizePythonName(identifier)).join('_').toLowerCase();
}

/**
 * Mirrors `strings.fix_reserved_words()`: a name equal (case-sensitively)
 * to an entry of `reservedWords` gets a trailing `_`. Real
 * openapi-python-client checks `dir(builtins)` plus a handful of extra
 * names (see `strings.RESERVED_WORDS`) and every Python keyword — pass that
 * set in rather than hand-maintaining a copy here, since it's a moving
 * target across Python/openapi-python-client versions; see
 * `../../lint/python/derive_reserved_model_members.py`, which derives it
 * from the pinned toolchain's own installed packages.
 */
function fixReservedWord(value: string, reservedWords: ReadonlySet<string>): string {
  return reservedWords.has(value) ? `${value}_` : value;
}

/** A conservative ASCII stand-in for CPython's `str.isidentifier()`. */
function looksLikeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/**
 * Mirrors `strings.PythonIdentifier`: the full transform openapi-python-client
 * applies to every generated name (operation function/file names, property
 * attribute names, and more) — `snake_case`, then `fix_reserved_words`, then
 * (only if the result still isn't a valid identifier, or started with `_`
 * before that check) a prefix (`field_` for properties and operation names).
 *
 * @param reservedWords the keyword/builtin names `fix_reserved_words` would
 * suffix with `_` — pass an empty set to skip that step entirely.
 */
export function pythonIdentifier(
  value: string,
  prefix: string,
  reservedWords: ReadonlySet<string> = new Set(),
): string {
  const sanitized = sanitizePythonName(value);
  const leadingUnderscore = sanitized.startsWith('_');
  const snakeCased = fixReservedWord(
    splitPythonWords(sanitized).join('_').toLowerCase(),
    reservedWords,
  );
  return !looksLikeIdentifier(snakeCased) || leadingUnderscore ? `${prefix}${snakeCased}` : snakeCased;
}
