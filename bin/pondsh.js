#!/usr/bin/env node
// Alias so `npx pondsh@<v> <args>` works without the -p flag. npx without -p
// looks for an executable matching the package name (pondsh), not the bin
// name (pond), so users who type the natural form hit "could not determine
// executable to run". This shim resolves that — `npx pondsh new ...` and
// `npx -p pondsh pond new ...` both end up at the same CLI entry.
import { main, runMain } from "../src/cli.js"
runMain(main)
