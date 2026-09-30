# hey-api integration

## Module resolution and import extensions

The `importFileExtension` field is set to `.js` because hey-api's auto-detection of `moduleResolution` can fail in consumer installations.

When `moduleResolution: NodeNext` is set in the building package's `tsconfig.json`, explicit file extensions are required on relative imports. hey-api tries to auto-detect this by walking up from _its own installed location_ looking for a `tsconfig.json` with `moduleResolution`/`module` set to `nodenext`/`node16`.

Inside this repo's checkout, that walk happens to reach this repo's own `tsconfig.json` (nodenext) and passes by accident. But for any real consumer (a plain `npm install speckify`), hey-api's installed location has no such `tsconfig` anywhere above it. The auto-detection finds nothing, and the generated imports come out extension-less — which NodeNext resolution then rejects outright.

Setting `importFileExtension` explicitly ensures the generated code works in both contexts: development and consumer installations.
