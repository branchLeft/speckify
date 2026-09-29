# speckify (launcher)

This PyPI package is a thin launcher, not Speckify itself. Speckify is a
Node CLI; `pip install speckify` gives you the `speckify` command by way of
`npx`, for a Python-first toolchain that would rather not add a separate
"install a Node package globally" step.

It checks that `node` (>=22) is on `PATH`, then execs:

```
npx --yes speckify@<this launcher's own version> <your args>
```

The launcher's version is kept in lockstep with the npm package's version —
see the repository root for Speckify itself.
